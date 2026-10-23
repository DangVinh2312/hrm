import { WorkRequestAction, WorkRequestResource } from '../work-request-authorization.types.js';
import { createHash, randomUUID } from 'node:crypto';
import { ProductInvalidRequest } from '../../../authorization/product-data.gateway.js';
import {
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductQuery,
} from '../../../authorization/services/product-authority.service.js';
import { hrScoped } from '../../hr/helpers/hr-database.helper.js';
import { replay } from '../../hr/helpers/hr-idempotency.helper.js';
import type { AttendanceEffectRepository } from '../../attendance/repositories/attendance-effect.repository.js';
import type { LeaveEffectRepository } from '../../leave/repositories/leave-effect.repository.js';
import { ApiRejection } from '../../../infrastructure/helpers/api-error.helper.js';
import { approvalChain, nextState } from '../helpers/work-request.helper.js';
import type {
  CancelInput,
  RequestKind,
  RequestState,
  SubmitResult,
} from '../work-request.types.js';

const OPERATION = 'workRequest.cancel';

/** Input of the registered commands: the validated cancellation and its payload hash. */
export interface CancelCommandInput extends CancelInput {
  /** SHA-256 hex of requestId, expectedVersion and reason (ADR 0017 §4). */
  readonly hash: string;
}

/** Same actor, operation, key and payload already committed: roll back, answer the stored result. */
class CancelReplayed extends Error {
  constructor(readonly result: SubmitResult) {
    super('Cancel replayed');
  }
}

/**
 * workRequest.cancel (the owner, a pending request) and workRequest.cancelApproved (HR, fresh, an
 * approved request) — design §6.2, D06/D07. `execute` matched the policy's plan on the request row
 * (`pendingStage` / `approvedFresh`) and locked it FOR NO KEY UPDATE, so concurrent cancels and
 * decisions on one request are serialized and the later one misses the plan (the state moved on).
 * Lock order (spec §7.3, ADR 0017 §2): request → idempotency read → leave bucket (annual leave:
 * one `reversal` per debit, UNIQUE, so a replay cannot refund twice) or WFH counters (ascending
 * month) → attendance period FOR SHARE, closed → 409 `error.periodClosed` (the request is the
 * attendance effect: leaving `approved` removes it from the sheet, nothing else to delete) →
 * state, decision, claim, audit. No employee or calendar lock is taken here, as in `decision`.
 * An approved request needs the HR reason (D06); the owner's reason on a pending one is optional.
 */
function cancellation(
  approved: boolean,
  attendanceEffects: AttendanceEffectRepository,
  leaveEffects: LeaveEffectRepository,
): ProductCommand<CancelCommandInput, SubmitResult> {
  return {
    resource: WorkRequestResource.WorkRequest,
    action: approved ? WorkRequestAction.CancelApproved : WorkRequestAction.Cancel,
    mode: 'write',
    target: (input) => input.requestId,
    run: async (ctx, input) => {
      const { manager } = ctx.tx;
      const [prior] = await manager.query<{ hash: string; result: SubmitResult }[]>(
        `SELECT payload_hash AS hash, result FROM hr_idempotency
          WHERE actor_id = $1 AND operation = $2 AND key = CAST($3 AS uuid)`,
        [ctx.actor.id, OPERATION, input.idempotencyKey],
      );
      if (prior) throw new CancelReplayed(replay(prior, input.hash));
      const [row] = await manager.query<
        { kind: RequestKind; state: RequestState; version: string }[]
      >(`SELECT kind, state, version::text AS version FROM work_request WHERE id = $1`, [
        ctx.target.key,
      ]);
      if (!row) throw new Error('Locked request is missing');
      if (row.version !== input.expectedVersion) throw new ProductCommandRejected('stale_version');
      const next = nextState(
        row.state,
        approved ? 'cancel_approved' : 'cancel',
        approvalChain(row.kind),
      );
      if (next === 'invalid_transition') throw new ProductCommandRejected(next);
      if (approved) {
        if (input.reason === null) throw new ProductInvalidRequest('A reason is required');
        if (row.kind === 'annual-leave')
          await leaveEffects.reverseApprovedLeave(ctx.tx, { requestId: ctx.target.key });
        if (row.kind === 'wfh')
          await attendanceEffects.reverseApprovedWfh(ctx.tx, {
            requestId: ctx.target.key,
          });
        // The same guard as the approval: every month of the request is open, locked FOR SHARE.
        await attendanceEffects.applyApprovedAttendance(ctx.tx, { requestId: ctx.target.key });
      }
      const [updated] = await manager.query<{ version: string }[]>(
        `WITH updated AS (UPDATE work_request SET state = $3, version = version + 1
            WHERE id = $1 AND version = CAST($2 AS int8) AND state = $4
            RETURNING version::text AS version)
         SELECT version FROM updated`,
        [ctx.target.key, input.expectedVersion, next, row.state],
      );
      if (!updated) throw new ProductCommandRejected('stale_version');
      await manager.query(
        `INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,actor_account_id,reason)
         VALUES($1,$2,'cancel','cancel','user',$3,$4)`,
        [randomUUID(), ctx.target.key, ctx.actor.id, input.reason],
      );
      const result: SubmitResult = { id: ctx.target.key, state: next, version: updated.version };
      // Two requests cancelled with one key at once are not serialized by the request lock: the
      // later claim waits for the first and then inserts nothing — a reused key.
      const claimed = await manager.query<unknown[]>(
        `INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result)
         VALUES($1,$2,CAST($3 AS uuid),$4,$5,CAST($6 AS jsonb))
         ON CONFLICT DO NOTHING RETURNING 1`,
        [
          ctx.actor.id,
          OPERATION,
          input.idempotencyKey,
          input.hash,
          ctx.target.key,
          JSON.stringify(result),
        ],
      );
      if (claimed.length !== 1) throw new ApiRejection('error.idempotencyKeyReused');
      await ctx.audit(approved ? 'hr.request.cancel-approved' : 'hr.request.cancel', {
        resource: WorkRequestResource.WorkRequest,
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return result;
    },
  };
}

/** The two cancel commands (owner on a pending request, HR on an approved one). */
export function createCancelCommands(
  attendanceEffects: AttendanceEffectRepository,
  leaveEffects: LeaveEffectRepository,
) {
  return {
    cancelPending: cancellation(false, attendanceEffects, leaveEffects),
    cancelApproved: cancellation(true, attendanceEffects, leaveEffects),
  } as const;
}

export type CancelCommands = ReturnType<typeof createCancelCommands>;

/**
 * workRequest.read on the requested record: its state and version, whether the caller owns it,
 * and this actor's claim for the key if any. Decides which command to run and answers a replay
 * after the request moved on, always behind a current read permission (C-19). Absent and
 * unreadable are both `undefined` (404).
 */
const cancelFacts: ProductQuery<
  CancelCommandInput,
  | {
      readonly state: RequestState;
      readonly version: string;
      readonly owner: boolean;
      readonly prior: { hash: string; result: SubmitResult } | null;
    }
  | undefined
> = {
  resource: WorkRequestResource.WorkRequest,
  action: WorkRequestAction.Read,
  target: (input) => input.requestId,
  run: async ({ tx, scope, actor }, input) => {
    const bound = hrScoped(scope, input.requestId, actor.id, OPERATION, input.idempotencyKey);
    const [row] = await tx.manager.query<
      {
        state: RequestState;
        version: string;
        owner: boolean;
        prior: { hash: string; result: SubmitResult } | null;
      }[]
    >(
      `SELECT r.state, r.version::text AS version,
              (r.owner_account_id = CAST(${bound.at(2)} AS uuid)) AS owner,
              (SELECT json_build_object('hash', i.payload_hash, 'result', i.result) FROM hr_idempotency i
                WHERE i.actor_id = CAST(${bound.at(2)} AS uuid) AND i.operation = ${bound.at(3)}
                  AND i.key = CAST(${bound.at(4)} AS uuid)) AS prior
         FROM work_request r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    return row;
  },
};

export const cancelCommands = (commands: CancelCommands) =>
  [commands.cancelPending, commands.cancelApproved] as const;

export const cancelQueries = [cancelFacts] as const;

/** Fixed key order, so the same cancellation hashes the same on retry; the key itself is not hashed. */
const payloadHash = (input: CancelInput) =>
  createHash('sha256')
    .update(JSON.stringify([input.requestId, input.expectedVersion, input.reason]))
    .digest('hex');

/** Cancellations bound to the registered commands/queries (T8 part B). */
export class RequestCancelService {
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly commands: CancelCommands,
  ) {}

  /**
   * The command follows the request's state, never the caller: read it (and any claim of this
   * key) under workRequest.read, then run `cancelPending` or `cancelApproved`, which recheck
   * everything on the locked row. `undefined` = absent, unreadable, or not the caller's to cancel
   * in this state (HTTP 404); the owner of an approved request gets `invalid_transition` (409,
   * B-23), the one fact about a request they already read. Returns after the commit.
   */
  async cancel(secret: string, input: CancelInput): Promise<SubmitResult | undefined> {
    const command: CancelCommandInput = { ...input, hash: payloadHash(input) };
    const seen = await this.authorization.query(secret, cancelFacts, command);
    if (seen === undefined) return undefined;
    if (seen.prior) return replay(seen.prior, command.hash);
    if (seen.version !== input.expectedVersion) throw new ProductCommandRejected('stale_version');
    const approved = seen.state === 'approved';
    const action = approved
      ? this.commands.cancelApproved
      : seen.state === 'pending_lead' || seen.state === 'pending_final'
        ? this.commands.cancelPending
        : undefined;
    if (!action) throw new ProductCommandRejected('invalid_transition');
    try {
      const result = await this.authorization.execute(secret, action, command);
      if (result) return result;
    } catch (error) {
      if (error instanceof CancelReplayed) return error.result;
      throw error;
    }
    // The plan missed the locked row: the caller may not cancel in this state, or a concurrent
    // change moved the request on (a same-key one is a replay, another a stale version).
    const again = await this.authorization.query(secret, cancelFacts, command);
    if (again?.prior) return replay(again.prior, command.hash);
    if (again && again.version !== input.expectedVersion)
      throw new ProductCommandRejected('stale_version');
    if (approved && seen.owner) throw new ProductCommandRejected('invalid_transition');
    return undefined;
  }
}

import { WorkRequestAction, WorkRequestResource } from '../work-request-authorization.types.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductCommandContext,
  type ProductQuery,
} from '../../../authorization/services/product-authority.service.js';
import { replay } from '../../hr/helpers/hr-idempotency.helper.js';
import type { AttendanceEffectRepository } from '../../attendance/repositories/attendance-effect.repository.js';
import type { LeaveEffectRepository } from '../../leave/repositories/leave-effect.repository.js';
import { ApiRejection } from '../../../infrastructure/helpers/api-error.helper.js';
import { approvalChain, nextState } from '../helpers/work-request.helper.js';
import type {
  ApprovalInput,
  ApprovalQueueView,
  DecidedRequestsView,
  RequestKind,
  RequestListQuery,
  RequestState,
  SubmitResult,
} from '../work-request.types.js';
import { hrScoped } from '../../hr/helpers/hr-database.helper.js';
import type { RequestApprovalReadRepository } from '../repositories/request-approval-read.repository.js';

const OPERATION = 'workRequest.decide';

/** Input of the registered commands: the validated decision and its payload hash. */
export interface DecideCommandInput extends ApprovalInput {
  /** SHA-256 hex of requestId, expectedVersion, decision and reason (ADR 0017 §4). */
  readonly hash: string;
}

/** One effect of an approval, written in the deciding transaction (spec §6.2 effects column). */
export type EffectPart = 'leave' | 'attendance' | 'wfh';

/** What a handler may read besides the locked request: the approver's D04 acknowledgement. */
export interface EffectOptions {
  readonly acknowledgeWfhLimit: boolean;
}

export type ApprovedEffects = Readonly<
  Partial<
    Record<
      EffectPart,
      (ctx: ProductCommandContext, requestId: string, options: EffectOptions) => Promise<void>
    >
  >
>;

/**
 * Parts an approval of each kind must write before it may reach `approved` (design §6.2, §9): the
 * leave debit, the WFH counter and the attendance effect. A kind is open only when every one of its
 * parts has a handler. The array order is the lock order (spec §7.3: bucket, then period), so the
 * `leave`/`wfh` part always runs before `attendance`.
 */
export const requiredEffects: Readonly<Record<RequestKind, readonly EffectPart[]>> = {
  'annual-leave': ['leave', 'attendance'],
  'unpaid-leave': ['attendance'],
  wfh: ['wfh', 'attendance'],
  'late-arrival': ['attendance'],
  'early-departure': ['attendance'],
};

/**
 * M3 gate (design §6.3 invariant 5, ADR 0017 §6): the effect handlers of every human decision
 * that reaches `approved` (final approval; the lead approval of late/early, §6.4.1), fixed at
 * boot. T8 registers all three parts, so every kind is open in production; a composition that
 * omits a part (tests) keeps the kinds that need it closed, with nothing written
 * (`final_approval_unavailable`, fail closed). All parts run in the deciding transaction, after
 * the request lock: the leave bucket, the WFH counter, then the attendance period FOR SHARE.
 */
export const createApprovedEffects = (
  attendanceEffects: AttendanceEffectRepository,
  leaveEffects: LeaveEffectRepository,
): ApprovedEffects => ({
  leave: (ctx, requestId) => leaveEffects.applyApprovedLeave(ctx.tx, { requestId }),
  wfh: (ctx, requestId, options) =>
    attendanceEffects.applyApprovedWfh(ctx.tx, {
      requestId,
      acknowledgeWfhLimit: options.acknowledgeWfhLimit,
    }),
  attendance: (ctx, requestId) => attendanceEffects.applyApprovedAttendance(ctx.tx, { requestId }),
});

/** Same actor, operation, key and payload already committed: roll back, answer the stored result. */
class DecisionReplayed extends Error {
  constructor(readonly result: SubmitResult) {
    super('Decision replayed');
  }
}

/**
 * workRequest.decideLead / decideFinal (design §6.2). `execute` matched the stage policy's plan on
 * the request row and locked it FOR NO KEY UPDATE, so concurrent decisions on one request are
 * serialized and the second one misses the plan (the state moved on). Lock order (ADR 0017 §2,
 * spec §7.3): request → idempotency read → effects (T7 leave bucket, T8 WFH counter, then the
 * attendance period FOR SHARE, all locked after the request) → writes. No employee or calendar lock is taken here, and no writer takes the request
 * after a bucket (submit locks employee → calendar only), so nobody waits in the opposite order.
 * Guards also bind Root (planUnrestricted skips the stage scope): version, no self decision, a
 * real transition, the current first-step approver, and the M3 gate.
 */
function decision(
  stage: 'lead' | 'final',
  effects: ApprovedEffects,
): ProductCommand<DecideCommandInput, SubmitResult> {
  return {
    resource: WorkRequestResource.WorkRequest,
    action: stage === 'lead' ? WorkRequestAction.DecideLead : WorkRequestAction.DecideFinal,
    mode: 'write',
    target: (input) => input.requestId,
    run: async (ctx, input) => {
      const { manager } = ctx.tx;
      const [prior] = await manager.query<{ hash: string; result: SubmitResult }[]>(
        `SELECT payload_hash AS hash, result FROM hr_idempotency
          WHERE actor_id = $1 AND operation = $2 AND key = CAST($3 AS uuid)`,
        [ctx.actor.id, OPERATION, input.idempotencyKey],
      );
      if (prior) throw new DecisionReplayed(replay(prior, input.hash));
      const [row] = await manager.query<
        {
          kind: RequestKind;
          state: RequestState;
          version: string;
          self: boolean;
          approver: boolean;
        }[]
      >(
        `SELECT r.kind, r.state, r.version::text AS version,
                (r.owner_account_id = $2 OR e.account_id IS NOT DISTINCT FROM CAST($2 AS uuid)) AS self,
                EXISTS (SELECT 1 FROM hr_request_lead l
                         WHERE l.request_id = r.id AND l.lead_account_id = $2) AS approver
           FROM work_request r JOIN employee e ON e.id = r.employee_id WHERE r.id = $1`,
        [ctx.target.key, ctx.actor.id],
      );
      if (!row) throw new Error('Locked request is missing');
      if (row.version !== input.expectedVersion) throw new ProductCommandRejected('stale_version');
      // §6.3 invariant 3: never one's own request, whatever the grants — neither the submitting
      // account nor the account the employee is linked to now (the system decisions of §6.4 are
      // written at submit, never here).
      if (row.self) throw new ProductAccessDenied();
      const next = nextState(row.state, `${stage}_${input.decision}`, approvalChain(row.kind));
      if (next === 'invalid_transition') throw new ProductCommandRejected(next);
      // The first step is the current lead's (§6.4, D02); for IAM the plan already says so.
      if (stage === 'lead' && !row.approver) throw new ProductAccessDenied();
      if (next === 'approved') {
        // All parts must exist before any runs: a half-open kind is refused with nothing written.
        const handlers = requiredEffects[row.kind].map((part) => effects[part]);
        const open = handlers.filter((handler) => handler !== undefined);
        if (open.length !== handlers.length)
          throw new ProductCommandRejected('final_approval_unavailable');
        for (const effect of open)
          await effect(ctx, ctx.target.key, { acknowledgeWfhLimit: input.acknowledgeWfhLimit });
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
         VALUES($1,$2,$3,$4,'user',$5,$6)`,
        [randomUUID(), ctx.target.key, stage, input.decision, ctx.actor.id, input.reason],
      );
      const result: SubmitResult = { id: ctx.target.key, state: next, version: updated.version };
      // Two requests decided with one key at once are not serialized by the request lock: the
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
      await ctx.audit(stage === 'lead' ? 'hr.request.decide-lead' : 'hr.request.decide-final', {
        resource: WorkRequestResource.WorkRequest,
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return result;
    },
  };
}

/** The two stage commands over a fixed effect set; the composition passes `createApprovedEffects(...)`. */
export function createApprovalCommands(effects: ApprovedEffects) {
  return {
    leadDecision: decision('lead', effects),
    finalDecision: decision('final', effects),
  } as const;
}

export type ApprovalCommands = ReturnType<typeof createApprovalCommands>;

/**
 * workRequest.read on the requested record: its state and version, and this actor's claim for the
 * key if any. Decides which stage command to run and answers a replay after the request moved on
 * (the decider keeps read through `decidedRequests`), so a replay always rechecks a current
 * permission on the request (C-19). Absent and unreadable are both `undefined` (404).
 */
const decisionFacts: ProductQuery<
  DecideCommandInput,
  | {
      readonly state: RequestState;
      readonly version: string;
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
        prior: { hash: string; result: SubmitResult } | null;
      }[]
    >(
      `SELECT r.state, r.version::text AS version,
              (SELECT json_build_object('hash', i.payload_hash, 'result', i.result) FROM hr_idempotency i
                WHERE i.actor_id = CAST(${bound.at(2)} AS uuid) AND i.operation = ${bound.at(3)}
                  AND i.key = CAST(${bound.at(4)} AS uuid)) AS prior
         FROM work_request r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    return row;
  },
};

export const approvalCommands = (commands: ApprovalCommands) =>
  [commands.leadDecision, commands.finalDecision] as const;

export const approvalQueries = (reads: RequestApprovalReadRepository) =>
  [decisionFacts, reads.leadQueue, reads.finalQueue, reads.decidedQuery] as const;

/** Fixed key order, so the same decision hashes the same on retry; the key itself is not hashed. */
const payloadHash = (input: ApprovalInput) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.requestId,
        input.expectedVersion,
        input.decision,
        input.reason,
        // Only a set flag joins the payload, so the hash of every decision made before D04 (and
        // of every one without the flag) is unchanged and its stored claim still replays.
        ...(input.acknowledgeWfhLimit ? [true] : []),
      ]),
    )
    .digest('hex');

/** Decisions and queues bound to the registered commands/queries (T6). */
export class RequestApprovalService {
  /** `commands` are the registered stage commands; tests may pass their own effect set. */
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly commands: ApprovalCommands,
    private readonly reads: RequestApprovalReadRepository,
  ) {}

  /**
   * The stage comes from the request's state, never from the caller: read it (and any claim of
   * this key) under workRequest.read, then run that stage's command, which rechecks everything
   * on the locked row. `undefined` = absent, unreadable, or a stage the caller may not decide
   * (HTTP 404). Returns only after the decision's transaction committed.
   */
  async decide(secret: string, input: ApprovalInput): Promise<SubmitResult | undefined> {
    const command: DecideCommandInput = { ...input, hash: payloadHash(input) };
    const seen = await this.authorization.query(secret, decisionFacts, command);
    if (seen === undefined) return undefined;
    if (seen.prior) return replay(seen.prior, command.hash);
    if (seen.version !== input.expectedVersion) throw new ProductCommandRejected('stale_version');
    const action =
      seen.state === 'pending_lead'
        ? this.commands.leadDecision
        : seen.state === 'pending_final'
          ? this.commands.finalDecision
          : undefined;
    if (!action) throw new ProductCommandRejected('invalid_transition');
    try {
      const result = await this.authorization.execute(secret, action, command);
      if (result) return result;
    } catch (error) {
      if (error instanceof DecisionReplayed) return error.result;
      throw error;
    }
    // The plan missed the locked row: the caller may not decide this stage, or a concurrent
    // decision moved the request on (then a same-key one is a replay, another a stale version).
    const again = await this.authorization.query(secret, decisionFacts, command);
    if (again?.prior) return replay(again.prior, command.hash);
    if (again && again.version !== input.expectedVersion)
      throw new ProductCommandRejected('stale_version');
    return undefined;
  }

  leadQueue(secret: string, query: RequestListQuery): Promise<ApprovalQueueView> {
    return this.authorization.query(secret, this.reads.leadQueue, query);
  }

  finalQueue(secret: string, query: RequestListQuery): Promise<ApprovalQueueView> {
    return this.authorization.query(secret, this.reads.finalQueue, query);
  }

  decided(secret: string, query: RequestListQuery): Promise<DecidedRequestsView> {
    return this.authorization.query(secret, this.reads.decidedQuery, query);
  }
}

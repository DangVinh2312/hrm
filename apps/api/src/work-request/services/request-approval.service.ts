import { createHash, randomUUID } from 'node:crypto';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductCommandContext,
  type ProductQuery,
} from '../../authorization/services/product-authority.service.js';
import { hrScoped } from '../../hr/hr-database.helper.js';
import { ApiRejection } from '../../infrastructure/api-error.helper.js';
import { approvalChain, nextState } from '../work-request.helper.js';
import type {
  ApprovalInput,
  ApprovalQueueView,
  RequestKind,
  RequestListQuery,
  RequestState,
  SubmitResult,
} from '../work-request.types.js';

const OPERATION = 'workRequest.decide';

const date = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Input of the registered commands: the validated decision and its payload hash. */
export interface DecideCommandInput extends ApprovalInput {
  /** SHA-256 hex of requestId, expectedVersion, decision and reason (ADR 0017 §4). */
  readonly hash: string;
}

/**
 * M3 gate (design §6.3 invariant 5, ADR 0017 §6): the effect handler of every human decision that
 * reaches `approved` (final approval; the lead approval of late/early, §6.4.1), fixed at boot.
 * Empty at M2, so each such decision is refused with nothing written.
 * shortcut: no handlers and no WFH counter/D04 `acknowledgeWfhLimit` yet — leave debit (T7),
 * attendance/WFH count and its bucket lock (T8) join here in this same transaction.
 */
const approvedEffects: Readonly<
  Partial<Record<RequestKind, (ctx: ProductCommandContext, requestId: string) => Promise<void>>>
> = {};

/** Same actor, operation, key and payload already committed: roll back, answer the stored result. */
class DecisionReplayed extends Error {
  constructor(readonly result: SubmitResult) {
    super('Decision replayed');
  }
}

/** A stored claim of this actor and key: replay it, or refuse the key for another payload. */
function replay(prior: { hash: string; result: SubmitResult }, hash: string): SubmitResult {
  // The key space is the actor's own (PK starts with actor_id): says nothing about others.
  if (prior.hash !== hash) throw new ApiRejection('error.idempotencyKeyReused');
  return prior.result;
}

/**
 * workRequest.decideLead / decideFinal (design §6.2). `execute` matched the stage policy's plan on
 * the request row and locked it FOR NO KEY UPDATE, so concurrent decisions on one request are
 * serialized and the second one misses the plan (the state moved on). Lock order (ADR 0017 §2,
 * spec §7.3): request → idempotency read → writes; no employee, bucket or calendar lock is taken
 * (no step needs one before M3), so no other writer can wait on these in the opposite order.
 * Guards also bind Root (planUnrestricted skips the stage scope): version, no self decision, a
 * real transition, the current first-step approver, and the M3 gate.
 */
function decision(stage: 'lead' | 'final'): ProductCommand<DecideCommandInput, SubmitResult> {
  return {
    resource: 'workRequest',
    action: stage === 'lead' ? 'decideLead' : 'decideFinal',
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
        const effect = approvedEffects[row.kind];
        if (!effect) throw new ProductCommandRejected('final_approval_unavailable');
        await effect(ctx, ctx.target.key);
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
        resource: 'workRequest',
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return result;
    },
  };
}

export const leadDecision = decision('lead');

export const finalDecision = decision('final');

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
  resource: 'workRequest',
  action: 'read',
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

/**
 * The caller's queue for one stage: the stage permission's plan (stage policy included) AND the
 * stage's state AND not the caller's own request, before count and page, oldest first. The lead
 * queue also requires the caller to be the current first-step approver, which the IAM plan
 * already implies and Root (no profile) never is.
 */
function queue(stage: 'lead' | 'final'): ProductQuery<RequestListQuery, ApprovalQueueView> {
  return {
    resource: 'workRequest',
    action: stage === 'lead' ? 'decideLead' : 'decideFinal',
    run: async ({ tx, scope, actor }, input) => {
      const bound = hrScoped(scope, actor.id, input.limit, input.offset);
      const approver =
        stage === 'lead'
          ? `AND EXISTS (SELECT 1 FROM hr_request_lead l WHERE l.request_id = r.id
                            AND l.lead_account_id = CAST(${bound.at(1)} AS uuid))`
          : '';
      const [row] = await tx.manager.query<ApprovalQueueView[]>(
        `WITH scoped AS (
           SELECT r.id, r.employee_id, r.kind, r.state, r.version, r.team_id, r.created_at FROM work_request r
            WHERE ${scope.sql} AND r.state = '${stage === 'lead' ? 'pending_lead' : 'pending_final'}'
              AND r.owner_account_id <> CAST(${bound.at(1)} AS uuid) ${approver})
         SELECT (SELECT count(*) FROM scoped)::text AS total,
                COALESCE((SELECT json_agg(json_build_object('id', p.id, 'employeeId', p.employee_id,
                    'kind', p.kind, 'state', p.state, 'version', p.version::text, 'teamId', p.team_id,
                    'createdAt', ${instant('p.created_at')}, 'startDate', ${date('g.first')},
                    'endDate', ${date('g.last')}, 'minutes', g.minutes) ORDER BY p.created_at, p.id)
                  FROM (SELECT * FROM scoped ORDER BY created_at, id
                         LIMIT CAST(${bound.at(2)} AS int8) OFFSET CAST(${bound.at(3)} AS int8)) p
                  CROSS JOIN LATERAL (SELECT min(s.work_date) AS first, max(s.work_date) AS last,
                         sum(s.minutes)::int AS minutes FROM work_request_segment s WHERE s.request_id = p.id) g),
                  '[]'::json) AS items`,
        bound.parameters,
      );
      return { total: row?.total ?? '0', items: row?.items ?? [] };
    },
  };
}

export const leadQueue = queue('lead');

export const finalQueue = queue('final');

export const approvalCommands = [leadDecision, finalDecision] as const;

export const approvalQueries = [decisionFacts, leadQueue, finalQueue] as const;

/** Fixed key order, so the same decision hashes the same on retry; the key itself is not hashed. */
const payloadHash = (input: ApprovalInput) =>
  createHash('sha256')
    .update(JSON.stringify([input.requestId, input.expectedVersion, input.decision, input.reason]))
    .digest('hex');

/** Decisions and queues bound to the registered commands/queries (T6). */
export class RequestApprovalService {
  constructor(private readonly authorization: ProductAuthorization) {}

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
        ? leadDecision
        : seen.state === 'pending_final'
          ? finalDecision
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
    return this.authorization.query(secret, leadQueue, query);
  }

  finalQueue(secret: string, query: RequestListQuery): Promise<ApprovalQueueView> {
    return this.authorization.query(secret, finalQueue, query);
  }
}

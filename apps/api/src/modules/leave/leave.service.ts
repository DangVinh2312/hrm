import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { ProductTransaction } from '../../database/product-transaction.runner.js';
import {
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductQuery,
} from '../../authorization/services/product-authority.service.js';
import { assertPeriodsOpen } from '../attendance/attendance.service.js';
import { replay } from '../hr/hr-idempotency.helper.js';
import { HR_TODAY, hrScoped } from '../hr/hr-database.helper.js';
import { ApiRejection } from '../../infrastructure/api-error.helper.js';
import {
  type AccrualFacts,
  accruedByMonth,
  entitledByMonth,
  firstMonthOver,
  leaveBalanceView,
  monthlyMinutes,
} from './leave-balance.helper.js';
import type {
  ApprovedLeaveEffect,
  DatedMinutes,
  LeaveAdjustmentInput,
  LeaveAdjustmentResult,
  LeaveBalanceQuery,
  LeaveBalanceView,
  LeaveExcessView,
  LeaveReconciliationQuery,
  LeaveReconciliationView,
  PendingMinutes,
} from './leave.types.js';

const date = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

/** Everything the balance of one employee and year depends on, from one consistent read. */
interface LeaveEmployeeFacts {
  readonly accrual: AccrualFacts;
  /** Opening and adjustment entries (signed), dated in the year. */
  readonly adjustments: readonly DatedMinutes[];
  /** Debits minus reversals by segment date: approved annual leave. */
  readonly approved: readonly DatedMinutes[];
  /** Segments of annual-leave requests waiting for a decision. */
  readonly pending: readonly PendingMinutes[];
}

/**
 * Facts of `employeeIds` for `year` (three reads of slowly changing profile data and one
 * statement for the ledger and the pending segments). The last one is a single statement on
 * purpose: a decision commits the request state and its debits together, so one snapshot never
 * counts a request as pending and approved, nor as neither (spec §7.3 step 6 argument, ADR 0017).
 * Bounded by the caller's id list (≤ 100) and by the year's segments of those employees.
 */
async function loadLeaveFacts(
  manager: EntityManager,
  employeeIds: readonly string[],
  year: number,
): Promise<ReadonlyMap<string, LeaveEmployeeFacts>> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const ids = [...employeeIds];
  const employees = await manager.query<
    { id: string; hiredOn: string; terminatedOn: string | null }[]
  >(
    `SELECT id::text AS id, ${date('hired_on')} AS "hiredOn", ${date('terminated_on')} AS "terminatedOn"
       FROM employee WHERE id = ANY(CAST($1 AS uuid[]))`,
    [ids],
  );
  const periods = await manager.query<
    {
      employeeId: string;
      status: 'probation' | 'official';
      startsOn: string;
      endsOn: string | null;
    }[]
  >(
    `SELECT employee_id::text AS "employeeId", status, ${date('starts_on')} AS "startsOn", ${date('ends_on')} AS "endsOn"
       FROM employment_status_period WHERE employee_id = ANY(CAST($1 AS uuid[])) AND starts_on <= CAST($2 AS date)`,
    [ids, to],
  );
  const rates = await manager.query<
    { employeeId: string; effectiveFrom: string; annualMinutes: number }[]
  >(
    `SELECT employee_id::text AS "employeeId", ${date('effective_from')} AS "effectiveFrom", annual_minutes AS "annualMinutes"
       FROM leave_rate WHERE employee_id = ANY(CAST($1 AS uuid[])) AND effective_from <= CAST($2 AS date)`,
    [ids, to],
  );
  const entries = await manager.query<
    {
      employeeId: string;
      source: 'ledger' | 'request';
      kind: string;
      date: string;
      minutes: number;
      requestId: string | null;
    }[]
  >(
    `SELECT l.employee_id::text AS "employeeId", 'ledger' AS source, l.entry_kind AS kind,
            ${date('l.effective_on')} AS date, l.minutes, NULL::text AS "requestId"
       FROM leave_ledger l
      WHERE l.employee_id = ANY(CAST($1 AS uuid[])) AND l.effective_on BETWEEN CAST($2 AS date) AND CAST($3 AS date)
     UNION ALL
     SELECT r.employee_id::text, 'request', r.state, ${date('s.work_date')}, s.minutes, r.id::text
       FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
      WHERE r.employee_id = ANY(CAST($1 AS uuid[])) AND r.kind = 'annual-leave'
        AND r.state IN ('pending_lead','pending_final')
        AND s.work_date BETWEEN CAST($2 AS date) AND CAST($3 AS date)`,
    [ids, from, to],
  );
  const result = new Map<string, LeaveEmployeeFacts>();
  for (const employee of employees) {
    const mine = entries.filter((e) => e.employeeId === employee.id);

    const ledger = (kinds: readonly string[]) =>
      mine.filter((e) => e.source === 'ledger' && kinds.includes(e.kind));

    result.set(employee.id, {
      accrual: {
        year,
        hiredOn: employee.hiredOn,
        terminatedOn: employee.terminatedOn,
        periods: periods.filter((p) => p.employeeId === employee.id),
        rates: rates.filter((r) => r.employeeId === employee.id),
      },
      adjustments: ledger(['opening', 'adjustment']),
      approved: [
        ...ledger(['debit']),
        ...ledger(['reversal']).map((e) => ({ date: e.date, minutes: -e.minutes })),
      ],
      pending: mine
        .filter((e) => e.source === 'request' && e.requestId !== null)
        .map((e) => ({ date: e.date, minutes: e.minutes, requestId: e.requestId as string })),
    });
  }
  return result;
}

const entitlement = (facts: LeaveEmployeeFacts) =>
  entitledByMonth(accruedByMonth(facts.accrual), facts.adjustments, facts.accrual.year);

/**
 * D09 check of a new annual-leave request (called by submit under the employee lock): for every
 * month of the year, approved + pending + the new segments dated up to its end must not exceed
 * the entitlement to its end (spec §8), so a day is only taken from leave already accrued. Refused
 * with `error.insufficientLeave` (422): the numbers are the caller's own leave facts, reached only
 * after the plan matched their own profile. No bucket lock: the employee lock already serializes
 * this account's submits, and a concurrent decision moves minutes from pending to approved in one
 * commit without changing the sum, so this read cannot oversubscribe (ADR 0017 §2).
 */
export async function assertLeaveAvailable(
  manager: EntityManager,
  employeeId: string,
  segments: readonly DatedMinutes[],
): Promise<void> {
  const first = segments[0];
  if (!first) throw new Error('A leave request has no segment');
  const year = Number(first.date.slice(0, 4));
  const facts = (await loadLeaveFacts(manager, [employeeId], year)).get(employeeId);
  if (!facts) throw new Error('Employee facts are missing');
  const committed = monthlyMinutes([...facts.approved, ...facts.pending, ...segments], year);
  if (firstMonthOver(entitlement(facts), committed) !== undefined)
    throw new ApiRejection('error.insufficientLeave');
}

/**
 * Debit of an approved annual-leave request: one ledger row per segment (UNIQUE per segment, so a
 * replay fails instead of debiting twice). Internal: only a decision transaction that has
 * already authorized the actor, locked the request row and is about to move it to `approved`
 * calls this, in that same transaction (design §6.3 invariant 5; there is no HTTP capability).
 * Lock order (spec §7.3): request (held by the caller) → bucket → writes. The bucket row of
 * (employee, year) is inserted if missing and locked FOR UPDATE before the balance is read, so
 * two decisions of one employee serialize even when the bucket is new. Refuses (409) a segment
 * not on an `official` day and any month where approved leave plus this request would exceed the
 * entitlement: approved leave never exceeds what was accrued, whatever happened since the submit
 * (an adjustment, a lower entitlement). Pending requests are not counted here: the D09 sum was
 * checked at submit, and any excess that appeared since is listed by `leaveReconciliation` for HR
 * rather than blocking every approval of the employee.
 */
export async function applyApprovedLeave(
  tx: ProductTransaction,
  input: ApprovedLeaveEffect,
): Promise<void> {
  const { manager } = tx;
  const [request] = await manager.query<{ employeeId: string; kind: string }[]>(
    `SELECT employee_id::text AS "employeeId", kind FROM work_request WHERE id = CAST($1 AS uuid)`,
    [input.requestId],
  );
  if (request?.kind !== 'annual-leave')
    throw new Error('Leave effect on a request that is not annual leave');
  const segments = await manager.query<{ date: string; minutes: number }[]>(
    `SELECT ${date('work_date')} AS date, minutes FROM work_request_segment
      WHERE request_id = CAST($1 AS uuid) ORDER BY work_date`,
    [input.requestId],
  );
  const first = segments[0];
  if (!first) throw new Error('A leave request has no segment');
  const year = Number(first.date.slice(0, 4));
  if (segments.some((s) => Number(s.date.slice(0, 4)) !== year))
    throw new Error('A leave request spans two years');
  await manager.query(
    `INSERT INTO leave_bucket(employee_id, year) VALUES (CAST($1 AS uuid), $2) ON CONFLICT DO NOTHING`,
    [request.employeeId, year],
  );
  await manager.query(
    `SELECT revision FROM leave_bucket WHERE employee_id = CAST($1 AS uuid) AND year = $2 FOR UPDATE`,
    [request.employeeId, year],
  );
  const days = await manager.query<{ status: string | null }[]>(
    `SELECT (SELECT p.status FROM employment_status_period p WHERE p.employee_id = CAST($1 AS uuid)
              AND p.starts_on <= d AND (p.ends_on IS NULL OR p.ends_on > d)) AS status
       FROM unnest(CAST($2 AS date[])) AS d`,
    [request.employeeId, segments.map((s) => s.date)],
  );
  if (days.some((d) => d.status !== 'official')) throw new ProductCommandRejected('not_official');
  const facts = (await loadLeaveFacts(manager, [request.employeeId], year)).get(request.employeeId);
  if (!facts) throw new Error('Employee facts are missing');
  // Approved leave plus this request: other pending requests are not counted here, so the
  // approver decides who gets the last minutes (the first debit wins, the next one is refused).
  const committed = monthlyMinutes([...facts.approved, ...segments], year);
  if (firstMonthOver(entitlement(facts), committed) !== undefined)
    throw new ProductCommandRejected('insufficient_leave');
  await manager.query(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, source_request_id, source_work_date)
     SELECT gen_random_uuid(), CAST($1 AS uuid), 'debit', s.work_date, s.minutes, s.request_id, s.work_date
       FROM work_request_segment s WHERE s.request_id = CAST($2 AS uuid)`,
    [request.employeeId, input.requestId],
  );
  await manager.query(
    `UPDATE leave_bucket SET revision = revision + 1 WHERE employee_id = CAST($1 AS uuid) AND year = $2`,
    [request.employeeId, year],
  );
}

/**
 * Reversal of an approved annual-leave request being cancelled (D06, E-12): one `reversal` per
 * debit of the request, same employee/date/minutes by FK, UNIQUE per debit — so a second reversal
 * of any debit fails in the database whatever the application did. Internal like
 * `applyApprovedLeave`: only the cancellation transaction that authorized the actor, locked the
 * request row and checked it is `approved` calls this. Lock order (spec §7.3): request (held) →
 * bucket → writes; the bucket of (employee, year) is locked FOR UPDATE first, so a cancellation
 * and an approval or an adjustment of one employee serialize. Never refused for balance: giving
 * minutes back cannot break the §8 invariant. Throws when the debits are not one per segment, an
 * invariant that only a manual ledger change could break.
 */
export async function reverseApprovedLeave(
  tx: ProductTransaction,
  input: ApprovedLeaveEffect,
): Promise<void> {
  const { manager } = tx;
  const [request] = await manager.query<{ employeeId: string; kind: string; year: number }[]>(
    `SELECT r.employee_id::text AS "employeeId", r.kind,
            (SELECT EXTRACT(year FROM min(s.work_date))::int FROM work_request_segment s
              WHERE s.request_id = r.id) AS year
       FROM work_request r WHERE r.id = CAST($1 AS uuid)`,
    [input.requestId],
  );
  if (request?.kind !== 'annual-leave')
    throw new Error('Leave reversal on a request that is not annual leave');
  await manager.query(
    `INSERT INTO leave_bucket(employee_id, year) VALUES (CAST($1 AS uuid), $2) ON CONFLICT DO NOTHING`,
    [request.employeeId, request.year],
  );
  await manager.query(
    `SELECT revision FROM leave_bucket WHERE employee_id = CAST($1 AS uuid) AND year = $2 FOR UPDATE`,
    [request.employeeId, request.year],
  );
  const reversed = await manager.query<unknown[]>(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reverses_entry_id)
     SELECT gen_random_uuid(), d.employee_id, 'reversal', d.effective_on, d.minutes, d.id
       FROM leave_ledger d WHERE d.source_request_id = CAST($1 AS uuid) AND d.entry_kind = 'debit'
     RETURNING 1`,
    [input.requestId],
  );
  const [segments] = await manager.query<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM work_request_segment WHERE request_id = CAST($1 AS uuid)`,
    [input.requestId],
  );
  if (reversed.length === 0 || reversed.length !== segments?.n)
    throw new Error('An approved leave request must have one debit per segment');
  await manager.query(
    `UPDATE leave_bucket SET revision = revision + 1 WHERE employee_id = CAST($1 AS uuid) AND year = $2`,
    [request.employeeId, request.year],
  );
}

const ADJUST_OPERATION = 'leave.adjust';

/** Same actor, operation, key and payload already committed: roll back, answer the stored result. */
class AdjustmentReplayed extends Error {
  constructor(readonly result: LeaveAdjustmentResult) {
    super('Adjustment replayed');
  }
}

export interface AdjustCommandInput extends LeaveAdjustmentInput {
  /** SHA-256 hex of the normalized payload, computed outside SQL (ADR 0017 §4). */
  readonly hash: string;
}

/**
 * employee.adjustLeaveBalance (matrix §5.2 leave-rate.adjust "ledger entry", D07, D14; HR, fresh
 * session): appends one signed `adjustment` to the ledger of the employee `execute` locked, dated
 * in an open month (409 `error.periodClosed` otherwise) and not before the hire date. `reference`
 * says where the number comes from and is a column CHECK too; entries are never edited or
 * deleted. Lock order (spec §7.3): employee (held) → idempotency read → bucket of
 * (employee, year) FOR UPDATE → period of the month FOR SHARE → entry, claim, audit. A negative
 * entry may take the entitlement below what was already approved or is waiting; that is HR's call
 * and shows in the reconciliation list, it is not refused here (spec §9).
 */
export const adjustLeaveBalance: ProductCommand<AdjustCommandInput, LeaveAdjustmentResult> = {
  resource: 'employee',
  action: 'adjustLeaveBalance',
  mode: 'write',
  target: (input) => input.employeeId,
  run: async (ctx, input) => {
    const { manager } = ctx.tx;
    const [prior] = await manager.query<{ hash: string; result: LeaveAdjustmentResult }[]>(
      `SELECT payload_hash AS hash, result FROM hr_idempotency
        WHERE actor_id = $1 AND operation = $2 AND key = CAST($3 AS uuid)`,
      [ctx.actor.id, ADJUST_OPERATION, input.idempotencyKey],
    );
    if (prior) throw new AdjustmentReplayed(replay(prior, input.hash));
    const [employee] = await manager.query<{ valid: boolean }[]>(
      'SELECT hired_on <= CAST($2 AS date) AS valid FROM employee WHERE id = $1',
      [ctx.target.key, input.effectiveOn],
    );
    if (!employee?.valid) throw new ProductCommandRejected('before_hire');
    const year = Number(input.effectiveOn.slice(0, 4));
    await manager.query(
      `INSERT INTO leave_bucket(employee_id, year) VALUES (CAST($1 AS uuid), $2) ON CONFLICT DO NOTHING`,
      [ctx.target.key, year],
    );
    await manager.query(
      `SELECT revision FROM leave_bucket WHERE employee_id = CAST($1 AS uuid) AND year = $2 FOR UPDATE`,
      [ctx.target.key, year],
    );
    await assertPeriodsOpen(manager, [input.effectiveOn]);
    const id = randomUUID();
    await manager.query(
      `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reference)
       VALUES ($1, $2, 'adjustment', CAST($3 AS date), $4, $5)`,
      [id, ctx.target.key, input.effectiveOn, input.minutes, input.reference],
    );
    await manager.query(
      `UPDATE leave_bucket SET revision = revision + 1 WHERE employee_id = CAST($1 AS uuid) AND year = $2`,
      [ctx.target.key, year],
    );
    const result: LeaveAdjustmentResult = { id };
    // Two adjustments with one key for two employees are not serialized by an employee lock: the
    // later claim waits for the first and then inserts nothing — a reused key.
    const claimed = await manager.query<unknown[]>(
      `INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result)
       VALUES($1,$2,CAST($3 AS uuid),$4,$5,CAST($6 AS jsonb))
       ON CONFLICT DO NOTHING RETURNING 1`,
      [
        ctx.actor.id,
        ADJUST_OPERATION,
        input.idempotencyKey,
        input.hash,
        ctx.target.key,
        JSON.stringify(result),
      ],
    );
    if (claimed.length !== 1) throw new ApiRejection('error.idempotencyKeyReused');
    await ctx.audit('hr.leave.adjust', {
      resource: 'employee',
      key: ctx.target.key,
      objectId: ctx.target.objectId,
    });
    return result;
  },
};

export const leaveCommands = [adjustLeaveBalance] as const;

/**
 * employee.readLeaveBalance (matrix §5.2 leave-balance.read: self, a lead's members, HR; Root):
 * the plan's scope on the employee row, then the balance at the report date (default: today by
 * the DB clock in the business timezone).
 */
export const leaveBalance: ProductQuery<LeaveBalanceQuery, LeaveBalanceView | undefined> = {
  resource: 'employee',
  action: 'readLeaveBalance',
  target: (input) => input.employeeId,
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.employeeId, input.asOn);
    const [row] = await tx.manager.query<{ id: string; asOn: string }[]>(
      `SELECT r.id::text AS id, ${date(`COALESCE(CAST(${bound.at(2)} AS date), ${HR_TODAY})`)} AS "asOn"
         FROM employee r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    if (!row) return undefined;
    const facts = (await loadLeaveFacts(tx.manager, [row.id], Number(row.asOn.slice(0, 4)))).get(
      row.id,
    );
    if (!facts) throw new Error('Employee facts are missing');
    return leaveBalanceView({
      employeeId: row.id,
      asOn: row.asOn,
      facts: facts.accrual,
      adjustments: facts.adjustments,
      approved: facts.approved,
      pending: facts.pending,
    });
  },
};

const cumulative = (months: readonly number[]) => {
  let sum = 0;
  return months.map((minutes) => (sum += minutes));
};

/**
 * Pending annual leave that already exceeds the accrual (T5 submitted without the D09 check): per
 * month of the year, approved + pending dated up to its end against the entitlement to its end.
 * Employees are those of the caller's `readLeaveBalance` scope with pending annual leave in the
 * year (paged by code, ≤ 100), their facts read in one batch. Information for HR: nothing here
 * cancels or edits a request (the decision to keep, tell or have it cancelled is theirs).
 */
export const leaveReconciliation: ProductQuery<LeaveReconciliationQuery, LeaveReconciliationView> =
  {
    resource: 'employee',
    action: 'readLeaveBalance',
    run: async ({ tx, scope }, input) => {
      const bound = hrScoped(scope, input.year, input.limit, input.offset);
      const [page] = await tx.manager.query<
        {
          year: number;
          total: string;
          employees: { id: string; code: string; name: string }[];
        }[]
      >(
        `WITH yr AS (SELECT COALESCE(CAST(${bound.at(1)} AS int), EXTRACT(year FROM ${HR_TODAY})::int) AS y),
         scoped AS (
           SELECT r.id, r.code, r.full_name FROM employee r, yr
            WHERE ${scope.sql}
              AND EXISTS (SELECT 1 FROM work_request q JOIN work_request_segment s ON s.request_id = q.id
                           WHERE q.employee_id = r.id AND q.kind = 'annual-leave'
                             AND q.state IN ('pending_lead','pending_final')
                             AND s.work_date BETWEEN make_date(yr.y,1,1) AND make_date(yr.y,12,31)))
         SELECT (SELECT y FROM yr) AS year, (SELECT count(*) FROM scoped)::text AS total,
                COALESCE((SELECT json_agg(json_build_object('id', p.id, 'code', p.code, 'name', p.full_name)
                                          ORDER BY p.code, p.id)
                            FROM (SELECT * FROM scoped ORDER BY code, id
                                   LIMIT CAST(${bound.at(2)} AS int8) OFFSET CAST(${bound.at(3)} AS int8)) p),
                         '[]'::json) AS employees`,
        bound.parameters,
      );
      if (!page) throw new Error('Reconciliation returned no row');
      if (page.employees.length === 0) return { year: page.year, total: page.total, items: [] };
      const facts = await loadLeaveFacts(
        tx.manager,
        page.employees.map((e) => e.id),
        page.year,
      );
      const items: LeaveExcessView[] = [];
      for (const employee of page.employees) {
        const own = facts.get(employee.id);
        if (!own) continue;
        const entitled = entitlement(own);
        const approved = cumulative(monthlyMinutes(own.approved, page.year));
        const pending = cumulative(monthlyMinutes(own.pending, page.year));
        entitled.forEach((minutes, index) => {
          const committed = (approved[index] ?? 0) + (pending[index] ?? 0);
          if (committed <= Math.max(0, minutes)) return;
          const month = index + 1;
          items.push({
            employeeId: employee.id,
            employeeCode: employee.code,
            employeeName: employee.name,
            month,
            accruedMinutes: minutes,
            approvedMinutes: approved[index] ?? 0,
            pendingMinutes: pending[index] ?? 0,
            excessMinutes: committed - Math.max(0, minutes),
            requestIds: [
              ...new Set(
                [...own.pending]
                  .sort(
                    (a, b) =>
                      a.date.localeCompare(b.date) || a.requestId.localeCompare(b.requestId),
                  )
                  .filter((p) => Number(p.date.slice(5, 7)) <= month)
                  .map((p) => p.requestId),
              ),
            ],
          });
        });
      }
      return { year: page.year, total: page.total, items };
    },
  };

export const leaveQueries = [leaveBalance, leaveReconciliation] as const;

/** Fixed key order, so the same adjustment hashes the same on retry; the key itself is not hashed. */
const adjustmentHash = (input: LeaveAdjustmentInput) =>
  createHash('sha256')
    .update(JSON.stringify([input.employeeId, input.minutes, input.effectiveOn, input.reference]))
    .digest('hex');

/** Leave operations bound to the registered commands/queries (T7). */
export class LeaveService {
  constructor(private readonly authorization: ProductAuthorization) {}

  /**
   * `undefined`: absent or outside the caller's scope (404). A replay returns the stored id after
   * the permission was checked again (the command only runs behind the current plan).
   */
  async adjust(
    secret: string,
    input: LeaveAdjustmentInput,
  ): Promise<LeaveAdjustmentResult | undefined> {
    try {
      return await this.authorization.execute(secret, adjustLeaveBalance, {
        ...input,
        hash: adjustmentHash(input),
      });
    } catch (error) {
      if (error instanceof AdjustmentReplayed) return error.result;
      throw error;
    }
  }

  /** `undefined`: absent or outside the caller's scope (404). */
  balance(secret: string, query: LeaveBalanceQuery): Promise<LeaveBalanceView | undefined> {
    return this.authorization.query(secret, leaveBalance, query);
  }

  reconciliation(
    secret: string,
    query: LeaveReconciliationQuery,
  ): Promise<LeaveReconciliationView> {
    return this.authorization.query(secret, leaveReconciliation, query);
  }
}

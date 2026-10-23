import type { EntityManager } from 'typeorm';
import type { ProductTransaction } from '../../../database/product-transaction.runner.js';
import { ProductCommandRejected } from '../../../authorization/services/product-authority.service.js';
import { ApiRejection } from '../../../infrastructure/helpers/api-error.helper.js';
import { firstMonthOver, monthlyMinutes } from '../helpers/leave-balance.helper.js';
import type { ApprovedLeaveEffect, DatedMinutes } from '../leave.types.js';
import { date, entitlement } from '../helpers/leave-facts.helper.js';
import type { LeaveFactsRepository } from './leave-facts.repository.js';

/**
 * Leave ledger effects of submit, approval and cancellation, written in the deciding transaction.
 * Holds only the facts repository (leave facts); the transaction manager arrives per call.
 */
export class LeaveEffectRepository {
  readonly #facts: LeaveFactsRepository;

  constructor(facts: LeaveFactsRepository) {
    this.#facts = facts;
  }

  /**
   * D09 check of a new annual-leave request (called by submit under the employee lock): for every
   * month of the year, approved + pending + the new segments dated up to its end must not exceed
   * the entitlement to its end (spec §8), so a day is only taken from leave already accrued. Refused
   * with `error.insufficientLeave` (422): the numbers are the caller's own leave facts, reached only
   * after the plan matched their own profile. No bucket lock: the employee lock already serializes
   * this account's submits, and a concurrent decision moves minutes from pending to approved in one
   * commit without changing the sum, so this read cannot oversubscribe (ADR 0017 §2).
   */
  async assertLeaveAvailable(
    manager: EntityManager,
    employeeId: string,
    segments: readonly DatedMinutes[],
  ): Promise<void> {
    const first = segments[0];
    if (!first) throw new Error('A leave request has no segment');
    const year = Number(first.date.slice(0, 4));
    const facts = (await this.#facts.loadLeaveFacts(manager, [employeeId], year)).get(employeeId);
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
  async applyApprovedLeave(tx: ProductTransaction, input: ApprovedLeaveEffect): Promise<void> {
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
    const facts = (await this.#facts.loadLeaveFacts(manager, [request.employeeId], year)).get(
      request.employeeId,
    );
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
  async reverseApprovedLeave(tx: ProductTransaction, input: ApprovedLeaveEffect): Promise<void> {
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
}

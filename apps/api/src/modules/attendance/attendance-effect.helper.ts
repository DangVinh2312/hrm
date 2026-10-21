import type { EntityManager } from 'typeorm';
import type { ProductTransaction } from '../../database/product-transaction.runner.js';
import { ApiRejection } from '../../infrastructure/api-error.helper.js';
import type { ApprovedAttendanceEffect, ApprovedWfhEffect } from './attendance.types.js';
import {
  WFH_MONTH_LIMIT,
  assertPeriodsOpen,
  date,
  firstOfMonth,
  monthsOf,
} from './attendance-facts.repository.js';

/** Segments of the locked request being approved, with its employee and kind. */
async function approvedRequest(manager: EntityManager, requestId: string) {
  const [request] = await manager.query<{ employeeId: string; kind: string }[]>(
    `SELECT employee_id::text AS "employeeId", kind FROM work_request WHERE id = CAST($1 AS uuid)`,
    [requestId],
  );
  if (!request) throw new Error('Effect on a missing request');
  const dates = (
    await manager.query<{ date: string }[]>(
      `SELECT ${date('work_date')} AS date FROM work_request_segment
        WHERE request_id = CAST($1 AS uuid) ORDER BY work_date`,
      [requestId],
    )
  ).map((s) => s.date);
  if (dates.length === 0) throw new Error('A request has no segment');
  return { ...request, dates };
}

/**
 * Attendance effect of an approval (design §6.2, §9): the approved request IS the effect — the
 * sheet reads the segments of `approved` requests, so there is no second copy to write or to
 * drift when a cancellation removes it (T7/D06). What the approval must still guarantee, in its
 * own transaction, is D07: every month the request touches is open, locked FOR SHARE until commit
 * (`assertPeriodsOpen`), so a close cannot slip between this check and the approval. Internal:
 * only a decision transaction that authorized the actor, locked the request row and any bucket
 * calls it (lock order: request → bucket → period, spec §7.3).
 */
export async function applyApprovedAttendance(
  tx: ProductTransaction,
  input: ApprovedAttendanceEffect,
): Promise<void> {
  const request = await approvedRequest(tx.manager, input.requestId);
  await assertPeriodsOpen(tx.manager, request.dates);
}

/**
 * WFH counter of an approval (D04, design §6.2). One counter row per (employee, month of the WFH
 * day): upserted with `INSERT … ON CONFLICT DO NOTHING` and locked FOR UPDATE in ascending month
 * order BEFORE any count is read, so two approvals racing for the fourth/fifth day serialize
 * even when the month has no row yet (never COUNT-then-INSERT). A month that would pass
 * `WFH_MONTH_LIMIT` is refused with `error.wfhLimitAckRequired` unless the approver acknowledged
 * the warning. Raised only inside the final decision, after the plan matched the request for the
 * approver, so the count is a fact the caller who may decide it can already read. Internal like
 * `applyApprovedLeave`: request lock held by the caller, no employee or calendar lock.
 */
export async function applyApprovedWfh(
  tx: ProductTransaction,
  input: ApprovedWfhEffect,
): Promise<void> {
  const { manager } = tx;
  const request = await approvedRequest(manager, input.requestId);
  if (request.kind !== 'wfh') throw new Error('WFH effect on a request that is not WFH');
  const months = monthsOf(request.dates);
  const days = months.map((month) => request.dates.filter((d) => firstOfMonth(d) === month).length);
  const counts: number[] = [];
  for (const month of months) {
    await manager.query(
      `INSERT INTO wfh_month_counter(employee_id, month) VALUES (CAST($1 AS uuid), CAST($2 AS date))
       ON CONFLICT DO NOTHING`,
      [request.employeeId, month],
    );
    const [row] = await manager.query<{ count: number }[]>(
      `SELECT approved_count AS count FROM wfh_month_counter
        WHERE employee_id = CAST($1 AS uuid) AND month = CAST($2 AS date) FOR UPDATE`,
      [request.employeeId, month],
    );
    if (!row) throw new Error('WFH counter is missing after its upsert');
    counts.push(row.count);
  }
  if (!input.acknowledgeWfhLimit && counts.some((n, i) => n + (days[i] ?? 0) > WFH_MONTH_LIMIT))
    throw new ApiRejection('error.wfhLimitAckRequired');
  for (const [i, month] of months.entries())
    await manager.query(
      `UPDATE wfh_month_counter SET approved_count = approved_count + $3, revision = revision + 1
        WHERE employee_id = CAST($1 AS uuid) AND month = CAST($2 AS date)`,
      [request.employeeId, month, days[i]],
    );
}

/**
 * Counter release of an approved WFH request being cancelled (D06, D-09): every month of its days
 * goes down by that month's days, in ascending month order and under the same counter locks as
 * the approval (`INSERT … ON CONFLICT DO NOTHING`, then `FOR UPDATE`), so a cancellation and an
 * approval of one employee serialize. It runs once: only the cancellation transaction that locked
 * the request row and moved it out of `approved` calls it, and `approved_count >= 0` (CHECK)
 * refuses a double release outright. Internal like `applyApprovedWfh`.
 */
export async function reverseApprovedWfh(
  tx: ProductTransaction,
  input: ApprovedAttendanceEffect,
): Promise<void> {
  const { manager } = tx;
  const request = await approvedRequest(manager, input.requestId);
  if (request.kind !== 'wfh') throw new Error('WFH reversal on a request that is not WFH');
  const months = monthsOf(request.dates);
  for (const month of months) {
    await manager.query(
      `INSERT INTO wfh_month_counter(employee_id, month) VALUES (CAST($1 AS uuid), CAST($2 AS date))
       ON CONFLICT DO NOTHING`,
      [request.employeeId, month],
    );
    await manager.query(
      `SELECT approved_count FROM wfh_month_counter
        WHERE employee_id = CAST($1 AS uuid) AND month = CAST($2 AS date) FOR UPDATE`,
      [request.employeeId, month],
    );
  }
  for (const month of months)
    await manager.query(
      `UPDATE wfh_month_counter SET approved_count = approved_count - $3, revision = revision + 1
        WHERE employee_id = CAST($1 AS uuid) AND month = CAST($2 AS date)`,
      [request.employeeId, month, request.dates.filter((d) => firstOfMonth(d) === month).length],
    );
}

/**
 * Approved WFH days of an employee in the month of each of `dates`, plus these dates, as the
 * submit warning `wfhLimitExceeded` (D04, D-07): a plain read without lock — the approver
 * rechecks under the counter lock, so a stale warning never lets a day through.
 */
export async function wfhLimitExceeded(
  manager: EntityManager,
  employeeId: string,
  dates: readonly string[],
): Promise<boolean> {
  const months = monthsOf(dates);
  const rows = await manager.query<{ month: string; count: number }[]>(
    `SELECT ${date('month')} AS month, approved_count AS count FROM wfh_month_counter
      WHERE employee_id = CAST($1 AS uuid) AND month = ANY(CAST($2 AS date[]))`,
    [employeeId, months],
  );
  return months.some(
    (month) =>
      (rows.find((r) => r.month === month)?.count ?? 0) +
        dates.filter((d) => firstOfMonth(d) === month).length >
      WFH_MONTH_LIMIT,
  );
}

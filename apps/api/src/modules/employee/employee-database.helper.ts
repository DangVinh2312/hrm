import type { EntityManager } from 'typeorm';
import {
  ProductCommandRejected,
  type ProductCommandContext,
} from '../../authorization/services/product-authority.service.js';
import { HR_COMPANY_ID, HR_TODAY, isUniqueViolation } from '../hr/helpers/hr-database.helper.js';
import { ApiRejection } from '../../infrastructure/helpers/api-error.helper.js';
import type { EmploymentState } from './employee.types.js';

export const date = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

export const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * State on the business date today. NULL only if the period chain is broken, which the commands
 * never produce; the mapper then fails closed instead of guessing a status.
 */
export const stateSql = (e: string) =>
  `CASE WHEN ${e}.terminated_on IS NOT NULL AND ${e}.terminated_on < ${HR_TODAY} THEN 'terminated'
        WHEN ${e}.hired_on > ${HR_TODAY} THEN 'notStarted'
        ELSE (SELECT p.status FROM employment_status_period p WHERE p.employee_id = ${e}.id
               AND p.starts_on <= ${HR_TODAY} AND (p.ends_on IS NULL OR p.ends_on > ${HR_TODAY})) END`;

export function employmentState(value: string | null): EmploymentState {
  if (
    value === 'probation' ||
    value === 'official' ||
    value === 'notStarted' ||
    value === 'terminated'
  )
    return value;
  throw new Error('Employment periods are inconsistent');
}

/** Runs one write and turns a UNIQUE violation into a 409 without naming the other record. */
export async function unique<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductCommandRejected('duplicate');
    throw error;
  }
}

/** Bumps the employee version of the locked target, if it still is `expected` (else 409). */
export async function bumpEmployee(
  ctx: ProductCommandContext,
  expected: string | undefined,
): Promise<string> {
  const rows = await ctx.tx.manager.query<{ version: string }[]>(
    `WITH updated AS (UPDATE employee SET version = version + 1
       WHERE id = $1 ${expected === undefined ? '' : 'AND version = CAST($2 AS int8)'}
       RETURNING version::text AS version) SELECT * FROM updated`,
    expected === undefined ? [ctx.target.key] : [ctx.target.key, expected],
  );
  if (!rows[0]) throw new ProductCommandRejected('stale_version');
  return rows[0].version;
}

/**
 * D07 for the two commands that move an employee's employment dates: a hire date or a last
 * working day makes the sheet of every month from that date on different, so none of those
 * months may be closed (409 `error.periodClosed`; HR reopens the month, changes the profile and
 * closes again). `attendance_period` has no row for a month nobody touched, and a close may start
 * at any time, so the check is only sound under the company row: `createEmployee` already holds
 * it FOR NO KEY UPDATE (its target) and a termination takes it FOR SHARE here, after the employee
 * lock `execute` took. A close holds it FOR NO KEY UPDATE through its snapshot, so it waits for
 * this transaction, or this one sees its committed result. Lock order: employee → company; the
 * close takes company → period and nobody takes the employee after the company, so no cycle.
 */
export async function assertSheetsOpenFrom(
  manager: EntityManager,
  from: string,
  lockCompany: boolean,
): Promise<void> {
  if (lockCompany)
    await manager.query('SELECT 1 FROM hr_company WHERE id = $1 FOR SHARE', [HR_COMPANY_ID]);
  const [row] = await manager.query<{ closed: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM attendance_period
             WHERE state = 'closed' AND month >= date_trunc('month', CAST($1 AS date))::date) AS closed`,
    [from],
  );
  if (row?.closed !== false) throw new ApiRejection('error.periodClosed');
}

export const employeeTarget = (ctx: ProductCommandContext) => ({
  resource: 'employee',
  key: ctx.target.key,
  objectId: ctx.target.objectId,
});

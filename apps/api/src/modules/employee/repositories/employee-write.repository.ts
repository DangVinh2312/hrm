import type { EntityManager } from 'typeorm';
import {
  ProductCommandRejected,
  type ProductCommandContext,
} from '../../../authorization/services/product-authority.service.js';
import { COMPANY_ID } from '../../permission/permission-database.helper.js';
import { isUniqueViolation } from '../../../infrastructure/helpers/database-error.helper.js';
import { ApiRejection } from '../../../infrastructure/helpers/api-error.helper.js';

/** Writes shared by the employee commands (UNIQUE mapping, version bump, D07 guard); no state. */
export class EmployeeWriteRepository {
  /** Runs one write and turns a UNIQUE violation into a 409 without naming the other record. */
  async unique<T>(write: Promise<T>): Promise<T> {
    try {
      return await write;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProductCommandRejected('duplicate');
      throw error;
    }
  }

  /** Bumps the employee version of the locked target, if it still is `expected` (else 409). */
  async bumpEmployee(ctx: ProductCommandContext, expected: string | undefined): Promise<string> {
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
  async assertSheetsOpenFrom(
    manager: EntityManager,
    from: string,
    lockCompany: boolean,
  ): Promise<void> {
    if (lockCompany)
      await manager.query('SELECT 1 FROM hr_company WHERE id = $1 FOR SHARE', [COMPANY_ID]);
    const [row] = await manager.query<{ closed: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM attendance_period
               WHERE state = 'closed' AND month >= date_trunc('month', CAST($1 AS date))::date) AS closed`,
      [from],
    );
    if (row?.closed !== false) throw new ApiRejection('error.periodClosed');
  }
}

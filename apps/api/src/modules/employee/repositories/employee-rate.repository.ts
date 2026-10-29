import { randomUUID } from 'node:crypto';
import type { ProductCommandContext } from '../../../authorization/services/product-authority.service.js';
import type { PermissionObjectRepository } from '../../permission/permission-object.repository.js';
import type { SettingReadRepository } from '../../setting/repositories/setting-read.repository.js';
import { SettingKey } from '../../setting/setting.registry.js';
import { EmployeeResource } from '../employee-authorization.types.js';

/**
 * Leave rate rows written by the employee commands (F3). The default rate is the
 * `hr.annualLeaveDefaultMinutes` setting in force when a row is written, read in the
 * caller's transaction and only when a row is about to be written, so a rate that already exists is
 * never rewritten when the setting changes (no retroactive effect).
 */
export class EmployeeRateRepository {
  readonly #objects: PermissionObjectRepository;
  readonly #settings: SettingReadRepository;

  constructor(objects: PermissionObjectRepository, settings: SettingReadRepository) {
    this.#objects = objects;
    this.#settings = settings;
  }

  async #defaultMinutes(ctx: ProductCommandContext): Promise<number> {
    const values = await this.#settings.read(ctx.tx.manager, [
      SettingKey.AnnualLeaveDefaultMinutes,
    ]);
    return values[SettingKey.AnnualLeaveDefaultMinutes];
  }

  /**
   * The default rate from `from`, unless a rate dated on or before it exists (HR's earlier choice,
   * or data from before the rate started at the official period, is kept). The employee row is locked by the command, as for
   * `adjustLeaveRate`, so the check cannot race another rate insert. The object is registered only
   * when a row is written. Returns the audit target of the new row, or `undefined`.
   */
  async defaultRateAt(ctx: ProductCommandContext, from: string) {
    const [row] = await ctx.tx.manager.query<{ present: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM leave_rate
                       WHERE employee_id = $1 AND effective_from <= CAST($2 AS date)) AS present`,
      [ctx.target.key, from],
    );
    if (row?.present !== false) return undefined;
    return this.#insert(ctx, ctx.target.key, from, await this.#defaultMinutes(ctx));
  }

  /** First rate of a new official employee: the given minutes, or the default setting in force. */
  async insertFor(
    ctx: ProductCommandContext,
    employeeId: string,
    from: string,
    minutes: number | 'default',
  ) {
    return this.#insert(
      ctx,
      employeeId,
      from,
      minutes === 'default' ? await this.#defaultMinutes(ctx) : minutes,
    );
  }

  /** Registers and inserts one rate row; the audit target of the row. */
  async #insert(ctx: ProductCommandContext, employeeId: string, from: string, minutes: number) {
    const id = randomUUID();
    const objectId = await this.#objects.register(ctx.tx, EmployeeResource.LeaveRate, id);
    await ctx.tx.manager.query(
      'INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes) VALUES($1,$2,$3,CAST($4 AS date),$5)',
      [id, objectId, employeeId, from, minutes],
    );
    return { resource: EmployeeResource.LeaveRate, key: id, objectId };
  }
}

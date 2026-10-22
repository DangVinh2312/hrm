import { HrResource, EmployeeAction } from '../hr/hr-authorization.types.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
} from '../../authorization/services/product-authority.service.js';
import { assertPeriodsOpen } from '../attendance/repositories/attendance-facts.repository.js';
import { replay } from '../hr/helpers/hr-idempotency.helper.js';
import { ApiRejection } from '../../infrastructure/helpers/api-error.helper.js';
import type {
  LeaveAdjustmentInput,
  LeaveAdjustmentResult,
  LeaveBalanceQuery,
  LeaveBalanceView,
  LeaveReconciliationQuery,
  LeaveReconciliationView,
} from './leave.types.js';
import { leaveBalance, leaveReconciliation } from './repositories/leave-read.repository.js';

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
  resource: HrResource.Employee,
  action: EmployeeAction.AdjustLeaveBalance,
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
      resource: HrResource.Employee,
      key: ctx.target.key,
      objectId: ctx.target.objectId,
    });
    return result;
  },
};

export const leaveCommands = [adjustLeaveBalance] as const;

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

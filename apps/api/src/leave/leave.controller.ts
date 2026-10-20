import { Controller, Get, Inject, NotFoundException, Param, Query, Req } from '@nestjs/common';
import { ProductAuthorize } from '../authorization/enforcement/product-authorization.module.js';
import { type HttpRequest, sessionSecret } from '../infrastructure/http-security.helper.js';
import { LEAVE_HTTP_PORT, type LeaveHttpPort } from './leave.http-port.js';
import { parseLeaveBalanceQuery, parseLeaveReconciliationQuery } from './leave.validator.js';

/** Annual leave balance reads (T7). Absent and not visible are the same 404. */
@Controller('api/hr')
export class LeaveController {
  constructor(@Inject(LEAVE_HTTP_PORT) private readonly leave: LeaveHttpPort) {}

  /** Balance of one employee at `?date=` (default today), D09 breakdown. */
  @Get('employees/:id/leave-balance')
  @ProductAuthorize('employee', 'readLeaveBalance')
  async balance(@Req() req: HttpRequest, @Param('id') id: string, @Query() query: unknown) {
    const view = await this.leave.balance(
      sessionSecret(req, this.leave.config),
      parseLeaveBalanceQuery(id, query),
    );
    if (view === undefined) throw new NotFoundException();
    return view;
  }

  /** Pending annual leave above the accrual, per month, for the caller's scope. */
  @Get('leave/reconciliation')
  @ProductAuthorize('employee', 'readLeaveBalance')
  reconciliation(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.leave.reconciliation(
      sessionSecret(req, this.leave.config),
      parseLeaveReconciliationQuery(query),
    );
  }
}

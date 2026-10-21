import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ProductAuthorize } from '../../authorization/enforcement/product-authorization.module.js';
import {
  type HttpRequest,
  enforceCsrf,
  sessionSecret,
} from '../../infrastructure/http-security.helper.js';
import { LEAVE_HTTP_PORT, type LeaveHttpPort } from './leave.http-port.js';
import {
  parseLeaveAdjustment,
  parseLeaveBalanceQuery,
  parseLeaveReconciliationQuery,
} from './leave.validator.js';

/** Annual leave balance reads (T7) and HR's ledger adjustment. Absent and not visible are the same 404. */
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

  /**
   * HR appends one `adjustment` entry (fresh session, CSRF, `Idempotency-Key`, mandatory
   * `reference`, open month); the entry is the response, never the balance.
   */
  @HttpCode(201)
  @Post('employees/:id/leave-adjustments')
  @ProductAuthorize('employee', 'adjustLeaveBalance')
  async adjust(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    enforceCsrf(req, this.leave.config);
    const secret = sessionSecret(req, this.leave.config);
    const created = await this.leave.adjust(
      secret,
      parseLeaveAdjustment(body, id, req.headers['idempotency-key']),
    );
    if (created === undefined) throw new NotFoundException();
    return created;
  }
}

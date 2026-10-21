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
import { ATTENDANCE_HTTP_PORT, type AttendanceHttpPort } from './attendance.http-port.js';
import {
  parseAttendanceMonth,
  parseAttendanceQuery,
  parsePeriodClose,
  parsePeriodReopen,
} from './attendance.validator.js';

/** Monthly attendance sheets and the HR close/reopen of a month (T8). Absent = not visible = 404. */
@Controller('api/hr')
export class AttendanceController {
  constructor(@Inject(ATTENDANCE_HTTP_PORT) private readonly attendance: AttendanceHttpPort) {}

  /** Sheet of one employee for `?month=YYYY-MM` (default: the current month). */
  @Get('employees/:id/attendance')
  @ProductAuthorize('employee', 'readAttendance')
  async period(@Req() req: HttpRequest, @Param('id') id: string, @Query() query: unknown) {
    const view = await this.attendance.period(
      sessionSecret(req, this.attendance.config),
      parseAttendanceQuery(id, query),
    );
    if (view === undefined) throw new NotFoundException();
    return view;
  }

  /** Close state and history of one month (HR, company scope); `404` when not readable. */
  @Get('attendance/periods/:month')
  @ProductAuthorize('hrCompany', 'read')
  async periodState(@Req() req: HttpRequest, @Param('month') month: string) {
    const view = await this.attendance.periodState(
      sessionSecret(req, this.attendance.config),
      parseAttendanceMonth(month),
    );
    if (view === undefined) throw new NotFoundException();
    return view;
  }

  /** HR closes a month (fresh session, CSRF): snapshot of every employee's sheet. */
  @HttpCode(200)
  @Post('attendance/periods/:month/close')
  @ProductAuthorize('hrCompany', 'managePeriod')
  close(@Req() req: HttpRequest, @Param('month') month: string, @Body() body: unknown) {
    enforceCsrf(req, this.attendance.config);
    return this.attendance.closePeriod(
      sessionSecret(req, this.attendance.config),
      parsePeriodClose(month, body),
    );
  }

  /** HR reopens a closed month with a reason (fresh session, CSRF, audited). */
  @HttpCode(200)
  @Post('attendance/periods/:month/reopen')
  @ProductAuthorize('hrCompany', 'managePeriod')
  reopen(@Req() req: HttpRequest, @Param('month') month: string, @Body() body: unknown) {
    enforceCsrf(req, this.attendance.config);
    return this.attendance.reopenPeriod(
      sessionSecret(req, this.attendance.config),
      parsePeriodReopen(month, body),
    );
  }
}

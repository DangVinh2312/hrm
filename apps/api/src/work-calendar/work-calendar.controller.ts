import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ProductAuthorize } from '../authorization/enforcement/product-authorization.module.js';
import {
  type HttpRequest,
  enforceCsrf,
  sessionSecret,
} from '../infrastructure/http-security.helper.js';
import { WORK_CALENDAR_HTTP_PORT, type WorkCalendarHttpPort } from './work-calendar.http-port.js';
import { parseCalendarDay, parseCalendarYear } from './work-calendar.validator.js';

/** Work calendar routes (T4): read by every HR role, changed by HR/Admin with fresh auth. */
@Controller('api/hr/work-calendar')
export class WorkCalendarController {
  constructor(@Inject(WORK_CALENDAR_HTTP_PORT) private readonly calendar: WorkCalendarHttpPort) {}

  @Get()
  @ProductAuthorize('workCalendar', 'read')
  async year(@Req() req: HttpRequest, @Query() query: unknown) {
    const secret = sessionSecret(req, this.calendar.config);
    const view = await this.calendar.year(secret, parseCalendarYear(query));
    if (!view) throw new NotFoundException();
    return view;
  }

  /** Exact Origin and CSRF token before any input is parsed. */
  @Put('days/:date')
  @ProductAuthorize('workCalendar', 'manage')
  setDay(@Req() req: HttpRequest, @Param('date') date: string, @Body() body: unknown) {
    enforceCsrf(req, this.calendar.config);
    const secret = sessionSecret(req, this.calendar.config);
    return this.calendar.setDay(secret, parseCalendarDay(date, body));
  }
}

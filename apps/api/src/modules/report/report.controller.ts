import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ProductAuthorize } from '../../authorization/enforcement/product-authorization.module.js';
import {
  type HttpRequest,
  sessionSecret,
} from '../../infrastructure/helpers/http-security.helper.js';
import { REPORT_HTTP_PORT, type ReportHttpPort } from './report.http-port.js';
import { parseReportQuery } from './report.validator.js';

/** Read-only reports (T9 part A). The scope of each action is applied inside the query. */
@Controller('api/hr/reports')
export class ReportController {
  constructor(@Inject(REPORT_HTTP_PORT) private readonly reports: ReportHttpPort) {}

  /** Attendance sheets per employee and month in `from..to`; closed months from their snapshot. */
  @Get('attendance')
  @ProductAuthorize('employee', 'reportAttendance')
  attendance(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.reports.query(
      sessionSecret(req, this.reports.config),
      parseReportQuery('attendance', query),
    );
  }

  /** D09 leave balance of every employee in scope at the cutoff `asOn`. */
  @Get('leave')
  @ProductAuthorize('employee', 'reportLeave')
  leave(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.reports.query(
      sessionSecret(req, this.reports.config),
      parseReportQuery('leave', query),
    );
  }

  /** Approved late arrivals / early departures per employee and month. */
  @Get('late-early')
  @ProductAuthorize('employee', 'reportLateEarly')
  lateEarly(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.reports.query(
      sessionSecret(req, this.reports.config),
      parseReportQuery('late-early', query),
    );
  }

  /** Approved WFH days per employee and month of the WFH day. */
  @Get('wfh')
  @ProductAuthorize('employee', 'reportWfh')
  wfh(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.reports.query(
      sessionSecret(req, this.reports.config),
      parseReportQuery('wfh', query),
    );
  }

  /** Length of service at the cutoff `asOn` from the employment history. */
  @Get('seniority')
  @ProductAuthorize('employee', 'reportSeniority')
  seniority(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.reports.query(
      sessionSecret(req, this.reports.config),
      parseReportQuery('seniority', query),
    );
  }
}

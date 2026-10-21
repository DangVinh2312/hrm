import { Controller, Get, Inject, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ProductAuthorize } from '../../authorization/enforcement/product-authorization.module.js';
import {
  type HttpRequest,
  sessionSecret,
} from '../../infrastructure/helpers/http-security.helper.js';
import { REPORT_HTTP_PORT, type ReportHttpPort } from './report.http-port.js';
import type { ReportKind } from './report.types.js';
import { parseReportExportQuery, parseReportQuery } from './report.validator.js';

/** The part of the response an export watches: a client that leaves before it is written. */
interface ExportResponse {
  readonly writableFinished: boolean;

  once(event: 'close', listener: () => void): unknown;
}

/**
 * Read-only reports (T9). The scope of each action is applied inside the query. Every report has
 * an `/export` twin (XLSX) that runs the same query and action; see `ReportService.export`.
 */
@Controller('api/hr/reports')
export class ReportController {
  constructor(@Inject(REPORT_HTTP_PORT) private readonly reports: ReportHttpPort) {}

  private page(kind: ReportKind, req: HttpRequest, query: unknown) {
    return this.reports.query(
      sessionSecret(req, this.reports.config),
      parseReportQuery(kind, query),
    );
  }

  /** The file, or nothing at all when the client has already gone (nothing was written anywhere). */
  private async download(kind: ReportKind, req: HttpRequest, query: unknown, res: ExportResponse) {
    const secret = sessionSecret(req, this.reports.config);
    const input = parseReportExportQuery(kind, query);
    const gone = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    const file = await this.reports.export(secret, input, gone.signal);
    if (!file) return undefined;
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.content.length,
    });
  }

  /** Attendance sheets per employee and month in `from..to`; closed months from their snapshot. */
  @Get('attendance')
  @ProductAuthorize('employee', 'reportAttendance')
  attendance(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.page('attendance', req, query);
  }

  @Get('attendance/export')
  @ProductAuthorize('employee', 'reportAttendance')
  exportAttendance(
    @Req() req: HttpRequest,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: ExportResponse,
  ) {
    return this.download('attendance', req, query, res);
  }

  /** D09 leave balance of every employee in scope at the cutoff `asOn`. */
  @Get('leave')
  @ProductAuthorize('employee', 'reportLeave')
  leave(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.page('leave', req, query);
  }

  @Get('leave/export')
  @ProductAuthorize('employee', 'reportLeave')
  exportLeave(
    @Req() req: HttpRequest,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: ExportResponse,
  ) {
    return this.download('leave', req, query, res);
  }

  /** Approved late arrivals / early departures per employee and month. */
  @Get('late-early')
  @ProductAuthorize('employee', 'reportLateEarly')
  lateEarly(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.page('late-early', req, query);
  }

  @Get('late-early/export')
  @ProductAuthorize('employee', 'reportLateEarly')
  exportLateEarly(
    @Req() req: HttpRequest,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: ExportResponse,
  ) {
    return this.download('late-early', req, query, res);
  }

  /** Approved WFH days per employee and month of the WFH day. */
  @Get('wfh')
  @ProductAuthorize('employee', 'reportWfh')
  wfh(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.page('wfh', req, query);
  }

  @Get('wfh/export')
  @ProductAuthorize('employee', 'reportWfh')
  exportWfh(
    @Req() req: HttpRequest,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: ExportResponse,
  ) {
    return this.download('wfh', req, query, res);
  }

  /** Length of service at the cutoff `asOn` from the employment history. */
  @Get('seniority')
  @ProductAuthorize('employee', 'reportSeniority')
  seniority(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.page('seniority', req, query);
  }

  @Get('seniority/export')
  @ProductAuthorize('employee', 'reportSeniority')
  exportSeniority(
    @Req() req: HttpRequest,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: ExportResponse,
  ) {
    return this.download('seniority', req, query, res);
  }

  /** Day and month each employee celebrates in `from..to` (29/02 shown on 28/02 in a common year). */
  @Get('birthday')
  @ProductAuthorize('employee', 'reportBirthday')
  birthday(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.page('birthday', req, query);
  }

  @Get('birthday/export')
  @ProductAuthorize('employee', 'reportBirthday')
  exportBirthday(
    @Req() req: HttpRequest,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: ExportResponse,
  ) {
    return this.download('birthday', req, query, res);
  }
}

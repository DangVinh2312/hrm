import { EmployeeAction, EmployeeResource } from '../employee/employee-authorization.types.js';
import {
  WorkCalendarAction,
  WorkCalendarResource,
} from '../work-calendar/work-calendar-authorization.types.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ProductAuthorize } from '../../authorization/enforcement/product-authorization.module.js';
import {
  type HttpRequest,
  enforceCsrf,
  sessionSecret,
} from '../../infrastructure/helpers/http-security.helper.js';
import { inputDate, inputUuid } from '../../infrastructure/helpers/input-validation.helper.js';
import { WORK_SCHEDULE_HTTP_PORT, type WorkScheduleHttpPort } from './work-schedule.http-port.js';
import {
  parseCompanySchedule,
  parseEmployeeFrame,
  parseEmployeeFrameKey,
  parseEmployeeScheduleQuery,
} from './work-schedule.validator.js';

const found = <T>(value: T | undefined): T => {
  if (value === undefined) throw new NotFoundException();
  return value;
};

/** Working hours (ADR-19): the company schedule and each employee's own frames. */
@Controller('api/hr')
export class WorkScheduleController {
  constructor(@Inject(WORK_SCHEDULE_HTTP_PORT) private readonly schedules: WorkScheduleHttpPort) {}

  private secret(req: HttpRequest): string {
    return sessionSecret(req, this.schedules.config);
  }

  /** Mutations: exact Origin and CSRF token before any input is parsed. */
  private mutation(req: HttpRequest): string {
    enforceCsrf(req, this.schedules.config);
    return this.secret(req);
  }

  @Get('work-calendar/schedule')
  @ProductAuthorize(WorkCalendarResource.WorkCalendar, WorkCalendarAction.Read)
  async companySchedule(@Req() req: HttpRequest) {
    return found(await this.schedules.companySchedule(this.secret(req)));
  }

  @Put('work-calendar/schedule/:effectiveFrom')
  @ProductAuthorize(WorkCalendarResource.WorkCalendar, WorkCalendarAction.ManageSchedule)
  putCompanySchedule(
    @Req() req: HttpRequest,
    @Param('effectiveFrom') effectiveFrom: string,
    @Body() body: unknown,
  ) {
    const secret = this.mutation(req);
    return this.schedules.putCompanySchedule(secret, parseCompanySchedule(effectiveFrom, body));
  }

  @Delete('work-calendar/schedule/:effectiveFrom')
  @ProductAuthorize(WorkCalendarResource.WorkCalendar, WorkCalendarAction.ManageSchedule)
  deleteCompanySchedule(@Req() req: HttpRequest, @Param('effectiveFrom') effectiveFrom: string) {
    const secret = this.mutation(req);
    return this.schedules.deleteCompanySchedule(secret, inputDate(effectiveFrom));
  }

  @Get('employees/:id/schedule-frames')
  @ProductAuthorize(EmployeeResource.Employee, EmployeeAction.ReadSchedule)
  async employeeFrames(@Req() req: HttpRequest, @Param('id') id: string) {
    return found(await this.schedules.employeeFrames(this.secret(req), inputUuid(id)));
  }

  @HttpCode(201)
  @Post('employees/:id/schedule-frames')
  @ProductAuthorize(EmployeeResource.Employee, EmployeeAction.ManageSchedule)
  async addEmployeeFrame(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.schedules.addEmployeeFrame(secret, parseEmployeeFrame(id, body)));
  }

  /** Ends the frame today, or removes it when it has not started. */
  @Delete('employees/:id/schedule-frames/:frameId')
  @ProductAuthorize(EmployeeResource.Employee, EmployeeAction.ManageSchedule)
  async endEmployeeFrame(
    @Req() req: HttpRequest,
    @Param('id') id: string,
    @Param('frameId') frameId: string,
  ) {
    const secret = this.mutation(req);
    return found(await this.schedules.endEmployeeFrame(secret, parseEmployeeFrameKey(id, frameId)));
  }

  /** The hours of each day of `?from&to` (at most 92 days), as requests see them. */
  @Get('employees/:id/schedule')
  @ProductAuthorize(EmployeeResource.Employee, EmployeeAction.ReadSchedule)
  async employeeDays(@Req() req: HttpRequest, @Param('id') id: string, @Query() query: unknown) {
    return found(
      await this.schedules.employeeDays(this.secret(req), parseEmployeeScheduleQuery(id, query)),
    );
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
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
import { hrUuid } from '../hr/helpers/hr-input.helper.js';
import { EMPLOYEE_HTTP_PORT, type EmployeeHttpPort } from './employee.http-port.js';
import {
  parseAccountLink,
  parseEmployeeCreate,
  parseEmployeeList,
  parseEmployeeUpdate,
  parseIdentityUpdate,
  parseLeaveRate,
  parseOfficial,
  parseTermination,
} from './employee.validator.js';

const found = <T>(value: T | undefined): T => {
  if (value === undefined) throw new NotFoundException();
  return value;
};

/** Employee profile routes (T3). Absent and not visible records are the same 404. */
@Controller('api/hr/employees')
export class EmployeeController {
  constructor(@Inject(EMPLOYEE_HTTP_PORT) private readonly employees: EmployeeHttpPort) {}

  private secret(req: HttpRequest): string {
    return sessionSecret(req, this.employees.config);
  }

  /** Mutations: exact Origin and CSRF token before any input is parsed. */
  private mutation(req: HttpRequest): string {
    enforceCsrf(req, this.employees.config);
    return this.secret(req);
  }

  @Get()
  @ProductAuthorize('employee', 'read')
  list(@Req() req: HttpRequest, @Query() query: unknown) {
    return this.employees.list(this.secret(req), parseEmployeeList(query));
  }

  @HttpCode(201)
  @Post()
  @ProductAuthorize('hrCompany', 'createEmployee')
  create(@Req() req: HttpRequest, @Body() body: unknown) {
    const secret = this.mutation(req);
    return this.employees.create(secret, parseEmployeeCreate(body));
  }

  @Get(':id')
  @ProductAuthorize('employee', 'read')
  async detail(@Req() req: HttpRequest, @Param('id') id: string) {
    return found(await this.employees.detail(this.secret(req), hrUuid(id)));
  }

  @Patch(':id')
  @ProductAuthorize('employee', 'update')
  async update(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.employees.update(secret, parseEmployeeUpdate(id, body)));
  }

  @HttpCode(200)
  @Post(':id/official')
  @ProductAuthorize('employee', 'update')
  async official(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.employees.confirmOfficial(secret, parseOfficial(id, body)));
  }

  @HttpCode(200)
  @Post(':id/termination')
  @ProductAuthorize('employee', 'update')
  async termination(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.employees.terminate(secret, parseTermination(id, body)));
  }

  @Get(':id/identity')
  @ProductAuthorize('employeeIdentity', 'read')
  async identity(@Req() req: HttpRequest, @Param('id') id: string) {
    return found(await this.employees.identity(this.secret(req), hrUuid(id)));
  }

  @Put(':id/identity')
  @ProductAuthorize('employeeIdentity', 'update')
  async updateIdentity(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.employees.updateIdentity(secret, parseIdentityUpdate(id, body)));
  }

  @Get(':id/leave-rates')
  @ProductAuthorize('leaveRate', 'read')
  async leaveRates(@Req() req: HttpRequest, @Param('id') id: string) {
    return { items: await this.employees.leaveRates(this.secret(req), hrUuid(id)) };
  }

  @HttpCode(201)
  @Post(':id/leave-rates')
  @ProductAuthorize('employee', 'adjustLeaveRate')
  async adjustLeaveRate(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.employees.adjustLeaveRate(secret, parseLeaveRate(id, body)));
  }

  @Put(':id/account')
  @ProductAuthorize('employee', 'linkAccount')
  async linkAccount(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    const secret = this.mutation(req);
    return found(await this.employees.linkAccount(secret, parseAccountLink(id, body)));
  }
}

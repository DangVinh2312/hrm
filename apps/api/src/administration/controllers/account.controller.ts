import { AccountAction, AccountResource } from '../account-authorization.types.js';
import { ProductAuthorize } from '../../authorization/enforcement/product-authorization.module.js';
import type { Row as ProductRow } from '../../authorization/product-data.gateway.js';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  inputBody,
  inputBoundaryRef,
  inputBoundaryVersionParam,
  inputRoleKey,
} from '../../infrastructure/helpers/input-validation.helper.js';
import {
  type HttpRequest,
  bodyFields,
  enforceCsrf,
  sessionSecret,
} from '../../infrastructure/helpers/http-security.helper.js';
import {
  ADMINISTRATION_HTTP_PORT,
  type AdministrationHttpPort,
} from '../administration.http-port.js';

const nullableText = (value: unknown) => (typeof value === 'string' ? value : null);

/** Account projection (account_directory): id, email, state, enrollment status; nothing else. */
const accountView = (row: ProductRow) => ({
  userId: row.key,
  email: nullableText(row.email),
  state: String(row.state),
  enrollment: nullableText(row.enrollment),
});

/** `?limit=&offset=` as bounded decimal strings; the gateway enforces the ranges (400). */
function pageQuery(query: unknown): { limit: number; offset: number } {
  if (typeof query !== 'object' || query === null || Array.isArray(query))
    throw new BadRequestException();
  const entries = Object.entries(query as Record<string, unknown>);
  if (
    entries.some(
      ([key, value]) =>
        !['limit', 'offset'].includes(key) || typeof value !== 'string' || !/^\d{1,5}$/.test(value),
    )
  )
    throw new BadRequestException();
  const values = Object.fromEntries(entries) as Record<string, string>;
  return { limit: Number(values.limit ?? '20'), offset: Number(values.offset ?? '0') };
}

/** Email accounts for Google first login. Cancel/remove is account.suspend. */
@Controller('api/administration/accounts')
export class AccountController {
  constructor(
    @Inject(ADMINISTRATION_HTTP_PORT) private readonly administration: AdministrationHttpPort,
  ) {}

  @HttpCode(201)
  @Post()
  @ProductAuthorize(AccountResource.Account, AccountAction.Provision)
  async provision(@Req() req: HttpRequest, @Body() body: unknown) {
    enforceCsrf(req, this.administration.config);
    const dto = bodyFields(body, ['email']);
    const row = await this.administration.provisionAccount(
      sessionSecret(req, this.administration.config),
      dto.email ?? '',
    );
    const view = accountView(row);
    return { userId: view.userId, email: view.email, state: view.state };
  }

  @Get()
  @ProductAuthorize(AccountResource.Account, AccountAction.Read)
  async list(@Req() req: HttpRequest, @Query() query: unknown) {
    const page = await this.administration.listAccounts(
      sessionSecret(req, this.administration.config),
      pageQuery(query),
    );
    return { items: page.items.map(accountView), total: page.total };
  }

  @HttpCode(200)
  @Post(':id/roles')
  @ProductAuthorize(AccountResource.Account, AccountAction.AssignRole)
  async assignRole(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    enforceCsrf(req, this.administration.config);
    const roleKey = inputRoleKey(inputBody(body, ['roleKey']).roleKey);
    if (
      !(await this.administration.assignRole(
        sessionSecret(req, this.administration.config),
        id,
        roleKey,
      ))
    )
      throw new NotFoundException();
    return { status: 'assigned' };
  }

  @HttpCode(200)
  @Delete(':id/roles/:roleKey')
  @ProductAuthorize(AccountResource.Account, AccountAction.RevokeRole)
  async revokeRole(
    @Req() req: HttpRequest,
    @Param('id') id: string,
    @Param('roleKey') roleKey: string,
  ) {
    enforceCsrf(req, this.administration.config);
    const key = inputRoleKey(roleKey);
    if (
      !(await this.administration.revokeRole(
        sessionSecret(req, this.administration.config),
        id,
        key,
      ))
    )
      throw new NotFoundException();
    return { status: 'revoked' };
  }

  @HttpCode(200)
  @Post(':id/boundaries')
  @ProductAuthorize(AccountResource.Account, AccountAction.BindBoundary)
  async bindBoundary(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    enforceCsrf(req, this.administration.config);
    const dto = inputBody(body, ['key', 'version']);
    const ref = inputBoundaryRef(dto.key, dto.version);
    if (
      !(await this.administration.bindBoundary(
        sessionSecret(req, this.administration.config),
        id,
        ref,
      ))
    )
      throw new NotFoundException();
    return { status: 'bound' };
  }

  @HttpCode(200)
  @Delete(':id/boundaries/:key/:version')
  @ProductAuthorize(AccountResource.Account, AccountAction.UnbindBoundary)
  async unbindBoundary(
    @Req() req: HttpRequest,
    @Param('id') id: string,
    @Param('key') key: string,
    @Param('version') version: string,
  ) {
    enforceCsrf(req, this.administration.config);
    const ref = inputBoundaryRef(key, inputBoundaryVersionParam(version));
    if (
      !(await this.administration.unbindBoundary(
        sessionSecret(req, this.administration.config),
        id,
        ref,
      ))
    )
      throw new NotFoundException();
    return { status: 'unbound' };
  }
}

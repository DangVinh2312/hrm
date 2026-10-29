import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ProductAuthorize } from '../../authorization/enforcement/product-authorization.module.js';
import {
  AccountAction,
  AccountResource,
} from '../../administration/account-authorization.types.js';
import {
  type HttpRequest,
  enforceCsrf,
  sessionSecret,
} from '../../infrastructure/helpers/http-security.helper.js';
import { RoleAction, RoleResource } from './role-authorization.types.js';
import { ROLE_HTTP_PORT, type RoleHttpPort } from './role.http-port.js';
import { parseRoleCreate, parseRoleKey, parseRoleUpdate } from './role.validator.js';

/**
 * Role matrix and runtime roles. `roles` needs `role.read`; the roles and rules of one IAM
 * account need `account.readPermissions`. Both answer 404 when the caller's plan does not reach
 * the record, so a missing grant, Root and an absent account look the same. The three writes each
 * check their own permission; Origin and CSRF come before any input is parsed.
 */
@Controller('api/administration')
export class RoleController {
  constructor(@Inject(ROLE_HTTP_PORT) private readonly roles: RoleHttpPort) {}

  @Get('roles')
  @ProductAuthorize(RoleResource.Role, RoleAction.Read)
  async list(@Req() req: HttpRequest) {
    const view = await this.roles.list(sessionSecret(req, this.roles.config));
    if (!view) throw new NotFoundException();
    return view;
  }

  @Get('accounts/:id/permissions')
  @ProductAuthorize(AccountResource.Account, AccountAction.ReadPermissions)
  async accountPermissions(@Req() req: HttpRequest, @Param('id') id: string) {
    const view = await this.roles.accountPermissions(sessionSecret(req, this.roles.config), id);
    if (!view) throw new NotFoundException();
    return view;
  }

  @Post('roles')
  @ProductAuthorize(RoleResource.Role, RoleAction.Create)
  create(@Req() req: HttpRequest, @Body() body: unknown) {
    enforceCsrf(req, this.roles.config);
    const secret = sessionSecret(req, this.roles.config);
    return this.roles.create(secret, parseRoleCreate(body));
  }

  @Put('roles/:key')
  @ProductAuthorize(RoleResource.Role, RoleAction.Update)
  update(@Req() req: HttpRequest, @Param('key') key: string, @Body() body: unknown) {
    enforceCsrf(req, this.roles.config);
    const secret = sessionSecret(req, this.roles.config);
    return this.roles.update(secret, parseRoleUpdate(key, body));
  }

  @Delete('roles/:key')
  @ProductAuthorize(RoleResource.Role, RoleAction.Delete)
  remove(@Req() req: HttpRequest, @Param('key') key: string) {
    enforceCsrf(req, this.roles.config);
    const secret = sessionSecret(req, this.roles.config);
    return this.roles.remove(secret, parseRoleKey(key));
  }
}

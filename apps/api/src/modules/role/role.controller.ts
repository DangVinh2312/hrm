import { Controller, Get, Inject, NotFoundException, Param, Req } from '@nestjs/common';
import { ProductAuthorize } from '../../authorization/enforcement/product-authorization.module.js';
import {
  AccountAction,
  AccountResource,
} from '../../administration/account-authorization.types.js';
import {
  type HttpRequest,
  sessionSecret,
} from '../../infrastructure/helpers/http-security.helper.js';
import { RoleAction, RoleResource } from './role-authorization.types.js';
import { ROLE_HTTP_PORT, type RoleHttpPort } from './role.http-port.js';

/**
 * Read-only role matrix (ADR 0041 §3, ADR 0046). `roles` needs `role.read`; the roles and rules
 * of one IAM account need `account.readPermissions`. Both answer 404 when the caller's plan does
 * not reach the record, so a missing grant, Root and an absent account look the same.
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
}

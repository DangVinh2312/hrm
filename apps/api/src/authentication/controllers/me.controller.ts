import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ProductAuthenticated } from '../../authorization/enforcement/product-authorization.module.js';
import {
  type HttpRequest,
  sessionSecret,
} from '../../infrastructure/helpers/http-security.helper.js';
import {
  AUTHENTICATION_HTTP_PORT,
  type AuthenticationHttpPort,
} from '../authentication.http-port.js';

/**
 * Session bootstrap for the web client. The route stays under `api/hr` (route inventory and
 * OpenAPI are pinned; the path is a stored contract), the owner is authentication (ADR 0036).
 */
@Controller('api/hr')
export class MeController {
  constructor(@Inject(AUTHENTICATION_HTTP_PORT) private readonly auth: AuthenticationHttpPort) {}

  /** Own profile link and granted menus; any signed-in account, with or without HR roles. */
  @Get('me')
  @ProductAuthenticated()
  me(@Req() req: HttpRequest) {
    return this.auth.me(sessionSecret(req, this.auth.config));
  }
}

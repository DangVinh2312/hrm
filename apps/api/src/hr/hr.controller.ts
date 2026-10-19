import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ProductAuthenticated } from '../authorization/enforcement/product-authorization.module.js';
import { type HttpRequest, sessionSecret } from '../infrastructure/http-security.helper.js';
import { HR_HTTP_PORT, type HrHttpPort } from './hr.http-port.js';

@Controller('api/hr')
export class HrController {
  constructor(@Inject(HR_HTTP_PORT) private readonly hr: HrHttpPort) {}

  /** Own profile link and granted menus; any signed-in account, with or without HR roles. */
  @Get('me')
  @ProductAuthenticated()
  me(@Req() req: HttpRequest) {
    return this.hr.me(sessionSecret(req, this.hr.config));
  }
}

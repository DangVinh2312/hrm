import { ProductPublic } from '../../authorization/enforcement/product-authorization.module.js';
import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import {
  type HttpRequest,
  type HttpResponse,
  bodyFields,
  cookieName,
  cookies,
  enforceCsrf,
  newCsrf,
  setCookie,
} from '../../infrastructure/helpers/http-security.helper.js';
import { AUTH_HTTP_PORT, type AuthHttpPort, type OidcCallbackOutcome } from '../auth.http-port.js';

/**
 * Fixed same-origin callback targets (ADR 0019; the link targets of ADR 0023 §3.6 are gone with
 * linking, ADR 0027 §6): code constants only, never a URL taken from the request.
 */
const callbackTarget = (outcome: OidcCallbackOutcome): string =>
  outcome.kind === 'authenticated' ? '/' : '/login?error=oidc';

@Controller('api/auth/oidc')
export class OidcController {
  constructor(@Inject(AUTH_HTTP_PORT) private readonly auth: AuthHttpPort) {}

  @HttpCode(200)
  @Post('begin')
  @ProductPublic()
  async oidcBegin(
    @Body() body: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    enforceCsrf(req, this.auth.config);
    const dto = bodyFields(body, ['issuer']);
    const browser = newCsrf();
    setCookie(res, this.auth.config, 'browser', browser, 600);
    const result = await this.auth.oidc.begin(
      dto.issuer!,
      browser,
      { purpose: 'login' },
      req.ip || 'unknown',
    );
    return { authorizationUrl: result };
  }

  @HttpCode(303)
  @Get('callback')
  @ProductPublic()
  async callback(
    @Req() req: HttpRequest,
    @Query('iss') issuer: string,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const browser = cookies(req, this.auth.config)[cookieName(this.auth.config, 'browser')] || '';
    const outcome = await this.auth.oidc.callback(
      issuer,
      new URL(req.originalUrl, this.auth.config.origin),
      browser,
    );
    setCookie(res, this.auth.config, 'browser', '', 0);
    // Max-Age is the DB's count of seconds left, computed with the session row (ADR 0022 §3).
    if (outcome.kind === 'authenticated')
      setCookie(res, this.auth.config, 'session', outcome.session.secret, outcome.session.maxAge);
    res.redirect(303, callbackTarget(outcome));
  }

  @HttpCode(200)
  @Post('activate')
  @ProductPublic()
  async oidcActivate(
    @Body() body: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    enforceCsrf(req, this.auth.config);
    const dto = bodyFields(body, ['issuer', 'token']);
    const browser = newCsrf();
    setCookie(res, this.auth.config, 'browser', browser, 600);
    return {
      authorizationUrl: await this.auth.oidc.begin(
        dto.issuer!,
        browser,
        { purpose: 'activation', activationToken: dto.token! },
        req.ip || 'unknown',
      ),
    };
  }
}

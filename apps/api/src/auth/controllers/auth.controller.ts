import {
  ProductAuthenticated,
  ProductPublic,
} from '../../authorization/enforcement/product-authorization.module.js';
import { Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  type HttpRequest,
  type HttpResponse,
  enforceCsrf,
  newCsrf,
  sessionSecret,
  setCookie,
} from '../../infrastructure/helpers/http-security.helper.js';
import { AUTH_HTTP_PORT, type AuthHttpPort } from '../auth.http-port.js';

/**
 * Session routes. Sign-in itself is Google OIDC only (`oidc.controller.ts`, ADR 0027 §1–2): there
 * is no local login, activation, password change, reset or password step-up.
 */
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AUTH_HTTP_PORT) private readonly auth: AuthHttpPort) {}

  /** Enabled sign-in methods only (no provider, client or account data); the shape is kept. */
  @Get('options')
  @ProductPublic()
  options() {
    return { methods: ['oidc'] };
  }

  @Get('csrf')
  @ProductPublic()
  csrf(@Res({ passthrough: true }) res: HttpResponse) {
    const csrfToken = newCsrf();
    setCookie(res, this.auth.config, 'csrf', csrfToken, 3600);
    return { csrfToken };
  }

  @Get('session')
  @ProductAuthenticated()
  async current(@Req() req: HttpRequest) {
    const secret = sessionSecret(req, this.auth.config);
    const session = await this.auth.currentSession(secret);
    return {
      userId: session.userId,
      method: session.method,
      assurance: session.assurance,
      menus: [...(await this.auth.menus(secret))],
    };
  }

  /** The caller's own email, Google account and second factor ("Tài khoản của tôi"). */
  @Get('account')
  @ProductAuthenticated()
  async account(@Req() req: HttpRequest) {
    const secret = sessionSecret(req, this.auth.config);
    const account = await this.auth.oidc.ownAccount(secret);
    // ADR 0026 §8: status and remaining codes only, never the secret, key id or times.
    const mfa = await this.auth.mfa.status(secret);
    // ADR 0023: bindings by reference; the provider subject never leaves the server.
    return {
      email: account.email,
      identities: account.identities.map(({ issuer, reference }) => ({ issuer, reference })),
      mfa: { status: mfa.status, recoveryCodesRemaining: mfa.recoveryCodesRemaining },
    };
  }

  @HttpCode(200)
  @Post('logout')
  @ProductAuthenticated()
  async logout(@Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse) {
    enforceCsrf(req, this.auth.config);
    await this.auth.identity.logout(sessionSecret(req, this.auth.config));
    setCookie(res, this.auth.config, 'session', '', 0);
    return { status: 'revoked' };
  }

  @HttpCode(200)
  @Post('logout-all')
  @ProductAuthenticated()
  async logoutAll(@Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse) {
    enforceCsrf(req, this.auth.config);
    await this.auth.identity.logout(sessionSecret(req, this.auth.config), true);
    setCookie(res, this.auth.config, 'session', '', 0);
    return { status: 'revoked' };
  }
}

import { ProductAuthenticated } from '../../authorization/enforcement/product-authorization.module.js';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  type HttpRequest,
  type HttpResponse,
  bodyFields,
  enforceCsrf,
  sessionSecret,
  setCookie,
} from '../../infrastructure/helpers/http-security.helper.js';
import { normalizeRecoveryCode } from '../helpers/totp.helper.js';
import {
  AUTHENTICATION_HTTP_PORT,
  type AuthenticationHttpPort,
} from '../authentication.http-port.js';
import type { ProductMfaProof } from '../services/product-mfa.service.js';

/** Exactly six ASCII digits; anything else is a malformed request, not a wrong code. */
function totpCode(value: string): string {
  if (!/^[0-9]{6}$/.test(value)) throw new BadRequestException();
  return value;
}

/** `{ code }` or `{ recoveryCode }`, never both, nothing else. */
function proof(body: unknown): ProductMfaProof {
  if (typeof body === 'object' && body !== null && Object.hasOwn(body, 'recoveryCode')) {
    const { recoveryCode } = bodyFields(body, ['recoveryCode']);
    if (normalizeRecoveryCode(recoveryCode) === undefined) throw new BadRequestException();
    return { recoveryCode: recoveryCode! };
  }
  return { code: totpCode(bodyFields(body, ['code']).code!) };
}

/**
 * The session's own TOTP second factor (ADR 0026 §8). Every route needs the session cookie and
 * CSRF; the service authenticates the session again in its fenced transaction. A secret or
 * recovery code appears only in the one response that creates it (`Cache-Control: no-store`).
 */
@Controller('api/auth/mfa')
export class MfaController {
  constructor(@Inject(AUTHENTICATION_HTTP_PORT) private readonly auth: AuthenticationHttpPort) {}

  @HttpCode(200)
  @Post('totp/setup')
  @ProductAuthenticated()
  async setup(@Body() body: unknown, @Req() req: HttpRequest) {
    enforceCsrf(req, this.auth.config);
    bodyFields(body ?? {}, []);
    const setup = await this.auth.mfa.setup(
      sessionSecret(req, this.auth.config),
      req.ip || 'unknown',
    );
    return { uri: setup.uri, secret: setup.secret };
  }

  @HttpCode(200)
  @Post('totp/confirm')
  @ProductAuthenticated()
  async confirm(
    @Body() body: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    enforceCsrf(req, this.auth.config);
    const code = totpCode(bodyFields(body, ['code']).code!);
    const result = await this.auth.mfa.confirm(
      sessionSecret(req, this.auth.config),
      code,
      req.ip || 'unknown',
    );
    setCookie(res, this.auth.config, 'session', result.session.secret, result.session.maxAge);
    return { expiresAt: result.session.expiresAt, recoveryCodes: [...result.recoveryCodes] };
  }

  @HttpCode(200)
  @Post('verify')
  @ProductAuthenticated()
  async verify(
    @Body() body: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    enforceCsrf(req, this.auth.config);
    const session = await this.auth.mfa.verify(
      sessionSecret(req, this.auth.config),
      proof(body),
      req.ip || 'unknown',
    );
    setCookie(res, this.auth.config, 'session', session.secret, session.maxAge);
    return { expiresAt: session.expiresAt };
  }

  @HttpCode(200)
  @Post('recovery-codes')
  @ProductAuthenticated()
  async regenerate(@Body() body: unknown, @Req() req: HttpRequest) {
    enforceCsrf(req, this.auth.config);
    bodyFields(body ?? {}, []);
    const codes = await this.auth.mfa.regenerateRecoveryCodes(
      sessionSecret(req, this.auth.config),
      req.ip || 'unknown',
    );
    return { recoveryCodes: [...codes] };
  }

  @HttpCode(200)
  @Delete('totp')
  @ProductAuthenticated()
  async remove(@Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse) {
    enforceCsrf(req, this.auth.config);
    const session = await this.auth.mfa.remove(
      sessionSecret(req, this.auth.config),
      req.ip || 'unknown',
    );
    setCookie(res, this.auth.config, 'session', session.secret, session.maxAge);
    return { expiresAt: session.expiresAt };
  }
}

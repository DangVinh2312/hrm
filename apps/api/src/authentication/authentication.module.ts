import { Module } from '@nestjs/common';
import { AuthenticationController } from './controllers/authentication.controller.js';
import { MfaController } from './controllers/mfa.controller.js';
import { OidcController } from './controllers/oidc.controller.js';

/** Needs AUTHENTICATION_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [AuthenticationController, OidcController, MfaController] })
export class AuthenticationModule {}

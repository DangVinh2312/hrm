import { Module } from '@nestjs/common';
import { AccountController } from './controllers/account.controller.js';
import { UserController } from './controllers/user.controller.js';

/** Needs ADMINISTRATION_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [UserController, AccountController] })
export class AdministrationModule {}

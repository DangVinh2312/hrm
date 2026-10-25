import { Module } from '@nestjs/common';
import { RoleController } from './role.controller.js';

/** Needs ROLE_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [RoleController] })
export class RoleModule {}

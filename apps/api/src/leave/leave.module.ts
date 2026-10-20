import { Module } from '@nestjs/common';
import { LeaveController } from './leave.controller.js';

/** Needs LEAVE_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [LeaveController] })
export class LeaveModule {}

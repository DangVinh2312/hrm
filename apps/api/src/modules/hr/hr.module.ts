import { Module } from '@nestjs/common';
import { HrController } from './hr.controller.js';

/** Needs HR_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [HrController] })
export class HrModule {}

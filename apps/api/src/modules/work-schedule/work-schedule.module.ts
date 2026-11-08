import { Module } from '@nestjs/common';
import { WorkScheduleController } from './work-schedule.controller.js';

/** Needs WORK_SCHEDULE_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [WorkScheduleController] })
export class WorkScheduleModule {}

import { Module } from '@nestjs/common';
import { WorkCalendarController } from './work-calendar.controller.js';

/** Needs WORK_CALENDAR_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [WorkCalendarController] })
export class WorkCalendarModule {}

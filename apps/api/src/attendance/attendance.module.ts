import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller.js';

/** Needs ATTENDANCE_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [AttendanceController] })
export class AttendanceModule {}

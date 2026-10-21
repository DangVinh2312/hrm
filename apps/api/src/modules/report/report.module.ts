import { Module } from '@nestjs/common';
import { ReportController } from './report.controller.js';

/** Needs REPORT_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [ReportController] })
export class ReportModule {}

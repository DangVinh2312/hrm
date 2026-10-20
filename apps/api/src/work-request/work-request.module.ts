import { Module } from '@nestjs/common';
import { WorkRequestController } from './work-request.controller.js';

/** Needs WORK_REQUEST_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [WorkRequestController] })
export class WorkRequestModule {}

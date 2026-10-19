import { Module } from '@nestjs/common';
import { EmployeeController } from './employee.controller.js';

/** Needs EMPLOYEE_HTTP_PORT; AppModule supplies the runtime module that exports it. */
@Module({ controllers: [EmployeeController] })
export class EmployeeModule {}

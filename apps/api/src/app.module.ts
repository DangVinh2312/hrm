import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProductAuthorizationModule } from './authorization/enforcement/product-authorization.module.js';
import { AdministrationModule } from './administration/administration.module.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DocumentModule } from './document/document.module.js';
import { EmployeeModule } from './modules/employee/employee.module.js';
import { HrModule } from './modules/hr/hr.module.js';
import { LeaveModule } from './modules/leave/leave.module.js';
import { TeamModule } from './modules/team/team.module.js';
import { WorkCalendarModule } from './modules/work-calendar/work-calendar.module.js';
import { WorkRequestModule } from './modules/work-request/work-request.module.js';
import { HealthModule } from './health/health.module.js';
import { sessionSecret, type HttpRequest } from './infrastructure/http-security.helper.js';
import { ProductErrorFilter } from './infrastructure/product-error.filter.js';
import type { ProductRuntime } from './infrastructure/product-runtime.service.js';
import { RuntimeModule } from './infrastructure/runtime.module.js';
import { OpenApiController } from './openapi/openapi.controller.js';

@Module({})
export class AppModule {
  /** Composition root; `runtime` may be a fixture (tests). No DB access here. */
  static register(runtime: ProductRuntime): DynamicModule {
    const runtimeModule = RuntimeModule.register(runtime);
    return {
      module: AppModule,
      imports: [
        ProductAuthorizationModule.register({
          declarations: runtime.release.declarations,
          requestAuth: {
            authenticate: (request) =>
              runtime.authorization.checkSession(
                sessionSecret(request as HttpRequest, runtime.config),
              ),
          },
        }),
        // Each feature module sees only the facade tokens RuntimeModule exports.
        ...[
          HealthModule,
          AuthModule,
          DocumentModule,
          AdministrationModule,
          HrModule,
          EmployeeModule,
          TeamModule,
          WorkCalendarModule,
          WorkRequestModule,
          LeaveModule,
          AttendanceModule,
        ].map((module) => ({
          module,
          imports: [runtimeModule],
        })),
      ],
      controllers: [OpenApiController],
      providers: [{ provide: APP_FILTER, useClass: ProductErrorFilter }],
    };
  }
}

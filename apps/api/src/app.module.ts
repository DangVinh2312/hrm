import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProductAuthorizationModule } from './authorization/enforcement/product-authorization.module.js';
import { AdministrationModule } from './administration/administration.module.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { AuthenticationModule } from './authentication/authentication.module.js';
import { EmployeeModule } from './modules/employee/employee.module.js';
import { LeaveModule } from './modules/leave/leave.module.js';
import { ReportModule } from './modules/report/report.module.js';
import { RoleModule } from './modules/role/role.module.js';
import { SettingModule } from './modules/setting/setting.module.js';
import { TeamModule } from './modules/team/team.module.js';
import { WorkCalendarModule } from './modules/work-calendar/work-calendar.module.js';
import { WorkScheduleModule } from './modules/work-schedule/work-schedule.module.js';
import { WorkRequestModule } from './modules/work-request/work-request.module.js';
import { HealthModule } from './health/health.module.js';
import { sessionDigest } from './authentication/services/product-identity.service.js';
import { sessionSecret, type HttpRequest } from './infrastructure/helpers/http-security.helper.js';
import { wellFormedBody } from './infrastructure/helpers/input-validation.helper.js';
import { ProductErrorFilter } from './infrastructure/product-error.filter.js';
import type { ProductRuntime } from './infrastructure/product-runtime.service.js';
import { RuntimeModule } from './infrastructure/runtime.module.js';
import { OpenApiController } from './openapi/openapi.controller.js';

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(wellFormedBody).forRoutes('*');
  }

  /** Composition root; `runtime` may be a fixture (tests). No DB access here. */
  static register(runtime: ProductRuntime): DynamicModule {
    const runtimeModule = RuntimeModule.register(runtime);
    return {
      module: AppModule,
      imports: [
        ProductAuthorizationModule.register({
          declarations: runtime.release.declarations,
          requestAuth: {
            // Cookie shape only: the session itself is resolved by the service, under the fence.
            authenticate: (request) => {
              sessionDigest(sessionSecret(request as HttpRequest, runtime.config));
              return Promise.resolve();
            },
          },
        }),
        // Each feature module sees only the facade tokens RuntimeModule exports.
        ...[
          HealthModule,
          AuthenticationModule,
          AdministrationModule,
          EmployeeModule,
          TeamModule,
          WorkCalendarModule,
          WorkScheduleModule,
          WorkRequestModule,
          LeaveModule,
          AttendanceModule,
          ReportModule,
          SettingModule,
          RoleModule,
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

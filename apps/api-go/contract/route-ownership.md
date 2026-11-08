# Route, controller, package Go

Viết tay từ ADR-22, sửa cùng `routes.json` khi thêm hoặc chuyển route. Route chuyển theo controller thật (ADR-20 mục 2), không theo tiền tố; package theo `package-dag.md`.

Cột Package Go và Đợt là đích. Route đang phục vụ tại Go nằm ở `httpapi.MigratedRoutes`: 5 route F2 và 11 route F3 của bảng dưới (`auth/session`, `auth/me` ở M2); route còn lại proxy sang NestJS.

| Đợt | Số route |
| --- | --- |
| F2 | 5 |
| F3 | 11 |
| M1 | 14 |
| M2 | 14 |
| M4 | 10 |
| M5 | 11 |
| M6 | 6 |
| M7 | 12 |
| M8 | 17 |

| Method | Path | Controller | Module TS | Package Go | Đợt |
| --- | --- | --- | --- | --- | --- |
| DELETE | `/api/administration/accounts/:id/boundaries/:key/:version` | `AccountController` | `administration` | `internal/administration` | M8 |
| DELETE | `/api/administration/accounts/:id/roles/:roleKey` | `AccountController` | `administration` | `internal/administration` | M8 |
| DELETE | `/api/administration/roles/:key` | `RoleController` | `modules/role` | `internal/modules/role` | M8 |
| DELETE | `/api/auth/mfa/totp` | `MfaController` | `authentication` | `internal/authentication` | F3 |
| DELETE | `/api/hr/employees/:id/schedule-frames/:frameId` | `WorkScheduleController` | `modules/work-schedule` | `internal/modules/workschedule` | M4 |
| DELETE | `/api/hr/teams/:id/members/:employeeId` | `TeamController` | `modules/team` | `internal/modules/team` | M1 |
| DELETE | `/api/hr/work-calendar/schedule/:effectiveFrom` | `WorkScheduleController` | `modules/work-schedule` | `internal/modules/workschedule` | M4 |
| GET | `/api/administration/accounts` | `AccountController` | `administration` | `internal/administration` | M8 |
| GET | `/api/administration/accounts/:id/permissions` | `RoleController` | `modules/role` | `internal/modules/role` | M8 |
| GET | `/api/administration/roles` | `RoleController` | `modules/role` | `internal/modules/role` | M8 |
| GET | `/api/administration/settings` | `SettingController` | `modules/setting` | `internal/modules/setting` | M1 |
| GET | `/api/administration/settings/:key/history` | `SettingController` | `modules/setting` | `internal/modules/setting` | M1 |
| GET | `/api/administration/settings/profile` | `SettingController` | `modules/setting` | `internal/modules/setting` | M1 |
| GET | `/api/administration/settings/security` | `SettingController` | `modules/setting` | `internal/modules/setting` | M1 |
| GET | `/api/auth/account` | `AuthenticationController` | `authentication` | `internal/authentication` | F3 |
| GET | `/api/auth/csrf` | `AuthenticationController` | `authentication` | `internal/httpapi` | F2 |
| GET | `/api/auth/me` | `AuthenticationController` | `authentication` | `internal/authentication` | M2 |
| GET | `/api/auth/oidc/callback` | `OidcController` | `authentication` | `internal/authentication` | F3 |
| GET | `/api/auth/options` | `AuthenticationController` | `authentication` | `internal/httpapi` | F2 |
| GET | `/api/auth/session` | `AuthenticationController` | `authentication` | `internal/authentication` | M2 |
| GET | `/api/health/live` | `HealthController` | `health` | `internal/health` | F2 |
| GET | `/api/health/metrics` | `HealthController` | `health` | `internal/health` | M8 |
| GET | `/api/health/ready` | `HealthController` | `health` | `internal/health` | F2 |
| GET | `/api/hr/approvals/decided` | `WorkRequestController` | `modules/work-request` | `internal/modules/workrequest` | M5 |
| GET | `/api/hr/approvals/final` | `WorkRequestController` | `modules/work-request` | `internal/modules/workrequest` | M5 |
| GET | `/api/hr/approvals/lead` | `WorkRequestController` | `modules/work-request` | `internal/modules/workrequest` | M5 |
| GET | `/api/hr/attendance/periods/:month` | `AttendanceController` | `modules/attendance` | `internal/modules/attendance` | M6 |
| GET | `/api/hr/employees` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| GET | `/api/hr/employees/:id` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| GET | `/api/hr/employees/:id/attendance` | `AttendanceController` | `modules/attendance` | `internal/modules/attendance` | M6 |
| GET | `/api/hr/employees/:id/attendance-adjustments` | `AttendanceController` | `modules/attendance` | `internal/modules/attendance` | M6 |
| GET | `/api/hr/employees/:id/identity` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| GET | `/api/hr/employees/:id/leave-balance` | `LeaveController` | `modules/leave` | `internal/modules/leave` | M5 |
| GET | `/api/hr/employees/:id/leave-rates` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| GET | `/api/hr/employees/:id/schedule` | `WorkScheduleController` | `modules/work-schedule` | `internal/modules/workschedule` | M4 |
| GET | `/api/hr/employees/:id/schedule-frames` | `WorkScheduleController` | `modules/work-schedule` | `internal/modules/workschedule` | M4 |
| GET | `/api/hr/employees/me` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| GET | `/api/hr/leave/reconciliation` | `LeaveController` | `modules/leave` | `internal/modules/leave` | M5 |
| GET | `/api/hr/reports/attendance` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/attendance/export` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/birthday` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/birthday/export` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/late-early` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/late-early/export` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/leave` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/leave/export` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/seniority` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/seniority/export` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/wfh` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/reports/wfh/export` | `ReportController` | `modules/report` | `internal/modules/report` | M7 |
| GET | `/api/hr/requests` | `WorkRequestController` | `modules/work-request` | `internal/modules/workrequest` | M5 |
| GET | `/api/hr/requests/:id` | `WorkRequestController` | `modules/work-request` | `internal/modules/workrequest` | M5 |
| GET | `/api/hr/teams` | `TeamController` | `modules/team` | `internal/modules/team` | M1 |
| GET | `/api/hr/teams/:id` | `TeamController` | `modules/team` | `internal/modules/team` | M1 |
| GET | `/api/hr/work-calendar` | `WorkCalendarController` | `modules/work-calendar` | `internal/modules/workcalendar` | M4 |
| GET | `/api/hr/work-calendar/schedule` | `WorkScheduleController` | `modules/work-schedule` | `internal/modules/workschedule` | M4 |
| GET | `/api/openapi.json` | `OpenApiController` | `openapi` | `internal/openapi` | F2 |
| PATCH | `/api/hr/employees/:id` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| PATCH | `/api/hr/teams/:id` | `TeamController` | `modules/team` | `internal/modules/team` | M1 |
| POST | `/api/administration/accounts` | `AccountController` | `administration` | `internal/administration` | M8 |
| POST | `/api/administration/accounts/:id/boundaries` | `AccountController` | `administration` | `internal/administration` | M8 |
| POST | `/api/administration/accounts/:id/google/reset` | `AccountController` | `administration` | `internal/administration` | M8 |
| POST | `/api/administration/accounts/:id/mfa/reset` | `AccountController` | `administration` | `internal/administration` | M8 |
| POST | `/api/administration/accounts/:id/roles` | `AccountController` | `administration` | `internal/administration` | M8 |
| POST | `/api/administration/roles` | `RoleController` | `modules/role` | `internal/modules/role` | M8 |
| POST | `/api/administration/users/:id/reactivate` | `UserController` | `administration` | `internal/administration` | M8 |
| POST | `/api/administration/users/:id/suspend` | `UserController` | `administration` | `internal/administration` | M8 |
| POST | `/api/auth/logout` | `AuthenticationController` | `authentication` | `internal/authentication` | F3 |
| POST | `/api/auth/logout-all` | `AuthenticationController` | `authentication` | `internal/authentication` | F3 |
| POST | `/api/auth/mfa/recovery-codes` | `MfaController` | `authentication` | `internal/authentication` | F3 |
| POST | `/api/auth/mfa/totp/confirm` | `MfaController` | `authentication` | `internal/authentication` | F3 |
| POST | `/api/auth/mfa/totp/setup` | `MfaController` | `authentication` | `internal/authentication` | F3 |
| POST | `/api/auth/mfa/verify` | `MfaController` | `authentication` | `internal/authentication` | F3 |
| POST | `/api/auth/oidc/activate` | `OidcController` | `authentication` | `internal/authentication` | F3 |
| POST | `/api/auth/oidc/begin` | `OidcController` | `authentication` | `internal/authentication` | F3 |
| POST | `/api/hr/attendance/periods/:month/close` | `AttendanceController` | `modules/attendance` | `internal/modules/attendance` | M6 |
| POST | `/api/hr/attendance/periods/:month/reopen` | `AttendanceController` | `modules/attendance` | `internal/modules/attendance` | M6 |
| POST | `/api/hr/employees` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| POST | `/api/hr/employees/:id/attendance-adjustments` | `AttendanceController` | `modules/attendance` | `internal/modules/attendance` | M6 |
| POST | `/api/hr/employees/:id/leave-adjustments` | `LeaveController` | `modules/leave` | `internal/modules/leave` | M5 |
| POST | `/api/hr/employees/:id/leave-rates` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| POST | `/api/hr/employees/:id/official` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| POST | `/api/hr/employees/:id/schedule-frames` | `WorkScheduleController` | `modules/work-schedule` | `internal/modules/workschedule` | M4 |
| POST | `/api/hr/employees/:id/termination` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| POST | `/api/hr/requests` | `WorkRequestController` | `modules/work-request` | `internal/modules/workrequest` | M5 |
| POST | `/api/hr/requests/:id/cancel` | `WorkRequestController` | `modules/work-request` | `internal/modules/workrequest` | M5 |
| POST | `/api/hr/requests/:id/decision` | `WorkRequestController` | `modules/work-request` | `internal/modules/workrequest` | M5 |
| POST | `/api/hr/teams` | `TeamController` | `modules/team` | `internal/modules/team` | M1 |
| POST | `/api/hr/teams/:id/members` | `TeamController` | `modules/team` | `internal/modules/team` | M1 |
| POST | `/api/hr/teams/:id/members/:employeeId/primary` | `TeamController` | `modules/team` | `internal/modules/team` | M1 |
| PUT | `/api/administration/accounts/:id/email` | `AccountController` | `administration` | `internal/administration` | M8 |
| PUT | `/api/administration/roles/:key` | `RoleController` | `modules/role` | `internal/modules/role` | M8 |
| PUT | `/api/administration/settings/profile/:key` | `SettingController` | `modules/setting` | `internal/modules/setting` | M1 |
| PUT | `/api/administration/settings/rule/:key` | `SettingController` | `modules/setting` | `internal/modules/setting` | M1 |
| PUT | `/api/hr/employees/:id/account` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| PUT | `/api/hr/employees/:id/identity` | `EmployeeController` | `modules/employee` | `internal/modules/employee` | M2 |
| PUT | `/api/hr/teams/:id/lead` | `TeamController` | `modules/team` | `internal/modules/team` | M1 |
| PUT | `/api/hr/work-calendar/days/:date` | `WorkCalendarController` | `modules/work-calendar` | `internal/modules/workcalendar` | M4 |
| PUT | `/api/hr/work-calendar/holidays` | `WorkCalendarController` | `modules/work-calendar` | `internal/modules/workcalendar` | M4 |
| PUT | `/api/hr/work-calendar/schedule/:effectiveFrom` | `WorkScheduleController` | `modules/work-schedule` | `internal/modules/workschedule` | M4 |

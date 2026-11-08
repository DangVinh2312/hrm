import { RequestMethod, type INestApplication } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService } from '@nestjs/core';

export interface RouteClassification {
  readonly kind: string;
  readonly resource?: string;
  readonly action?: string;
}

export interface RouteEntry {
  readonly inventory: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly classifications: readonly RouteClassification[];
  readonly controller: string;
  readonly handler: string;
}

/** Every route the given controller classes declare, read from their Nest metadata. */
export function routeEntries(
  controllers: readonly { readonly name: string; readonly prototype: object }[],
): RouteEntry[] {
  return controllers
    .flatMap((metatype) => {
      const prefix = Reflect.getMetadata(PATH_METADATA, metatype) as string;
      const prototype = metatype.prototype as Record<string, unknown>;
      return Object.getOwnPropertyNames(prototype).flatMap((name) => {
        const handler = prototype[name] as object;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) return [];
        const path = [prefix, Reflect.getMetadata(PATH_METADATA, handler) as string]
          .filter((p) => p && p !== '/')
          .join('/');
        const status =
          (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ??
          (method === RequestMethod.POST ? 201 : 200);
        const key = (Reflect.getOwnMetadataKeys(handler) as unknown[]).find(
          (k) => typeof k === 'symbol' && k.description === 'PRODUCT_ROUTE_CLASSIFICATION',
        );
        const classes = (key ? Reflect.getOwnMetadata(key, handler) : []) as RouteClassification[];
        const classification = classes
          .map((c) => (c.kind === 'authorize' ? `${c.resource}.${c.action}` : c.kind))
          .join(',');
        return [
          {
            inventory: `${RequestMethod[method]} /${path} ${status} ${classification}`,
            method: RequestMethod[method],
            path: `/${path}`,
            status,
            classifications: classes,
            controller: metatype.name,
            handler: name,
          },
        ];
      });
    })
    .sort((a, b) => (a.inventory < b.inventory ? -1 : a.inventory > b.inventory ? 1 : 0));
}

export function routeInventory(app: INestApplication): string[] {
  return routeEntries(
    app
      .get(DiscoveryService, { strict: false })
      .getControllers()
      .map(({ metatype }) => metatype!),
  ).map((route) => route.inventory);
}

// Email accounts (provision/read), own sign-in methods and public enabled methods.
// Link proof routes, unlink and the OIDC step-up removed again.
// T3: HR bootstrap, employee profile (F1/F2/F3, account link) and team/membership/lead routes.
// T4: work calendar read (every HR role) and change of one weekday (HR/Admin, fresh).
// T5: submit a request on the own profile, own request list and request detail.
// T6: decide a request at its stored stage (session-classified: the permission follows the state)
// and the lead/final queues.
// The session's own TOTP second factor (setup, confirm, verify, recovery codes, remove).
export const expectedRoutes = [
  'DELETE /api/administration/accounts/:id/boundaries/:key/:version 200 account.unbindBoundary',
  'DELETE /api/administration/accounts/:id/roles/:roleKey 200 account.revokeRole',
  'DELETE /api/administration/roles/:key 200 role.delete',
  'DELETE /api/auth/mfa/totp 200 authenticated',
  'DELETE /api/hr/employees/:id/schedule-frames/:frameId 200 employee.manageSchedule',
  'DELETE /api/hr/teams/:id/members/:employeeId 200 team.assign',
  'DELETE /api/hr/work-calendar/schedule/:effectiveFrom 200 workCalendar.manageSchedule',
  'GET /api/administration/accounts 200 account.read',
  'GET /api/administration/accounts/:id/permissions 200 account.readPermissions',
  'GET /api/administration/roles 200 role.read',
  'GET /api/administration/settings 200 setting.read',
  'GET /api/administration/settings/:key/history 200 setting.read',
  'GET /api/administration/settings/profile 200 setting.readProfile',
  'GET /api/administration/settings/security 200 setting.read',
  'GET /api/auth/account 200 authenticated',
  'GET /api/auth/csrf 200 public',
  'GET /api/auth/me 200 authenticated',
  'GET /api/auth/oidc/callback 303 public',
  'GET /api/auth/options 200 public',
  'GET /api/auth/session 200 authenticated',
  'GET /api/health/live 200 public',
  'GET /api/health/metrics 200 public',
  'GET /api/health/ready 200 public',
  'GET /api/hr/approvals/decided 200 workRequest.readDecided',
  'GET /api/hr/approvals/final 200 workRequest.decideFinal',
  'GET /api/hr/approvals/lead 200 workRequest.decideLead',
  'GET /api/hr/attendance/periods/:month 200 hrCompany.read',
  'GET /api/hr/employees 200 employee.read',
  'GET /api/hr/employees/:id 200 employee.read',
  'GET /api/hr/employees/:id/attendance 200 employee.readAttendance',
  'GET /api/hr/employees/:id/attendance-adjustments 200 employee.readAttendanceAdjustment',
  'GET /api/hr/employees/:id/identity 200 employeeIdentity.read',
  'GET /api/hr/employees/:id/leave-balance 200 employee.readLeaveBalance',
  'GET /api/hr/employees/:id/leave-rates 200 leaveRate.read',
  'GET /api/hr/employees/:id/schedule 200 employee.readSchedule',
  'GET /api/hr/employees/:id/schedule-frames 200 employee.readSchedule',
  'GET /api/hr/employees/me 200 authenticated',
  'GET /api/hr/leave/reconciliation 200 employee.readLeaveBalance',
  'GET /api/hr/reports/attendance 200 employee.reportAttendance',
  'GET /api/hr/reports/attendance/export 200 employee.reportAttendance',
  'GET /api/hr/reports/birthday 200 employee.reportBirthday',
  'GET /api/hr/reports/birthday/export 200 employee.reportBirthday',
  'GET /api/hr/reports/late-early 200 employee.reportLateEarly',
  'GET /api/hr/reports/late-early/export 200 employee.reportLateEarly',
  'GET /api/hr/reports/leave 200 employee.reportLeave',
  'GET /api/hr/reports/leave/export 200 employee.reportLeave',
  'GET /api/hr/reports/seniority 200 employee.reportSeniority',
  'GET /api/hr/reports/seniority/export 200 employee.reportSeniority',
  'GET /api/hr/reports/wfh 200 employee.reportWfh',
  'GET /api/hr/reports/wfh/export 200 employee.reportWfh',
  'GET /api/hr/requests 200 workRequest.read',
  'GET /api/hr/requests/:id 200 workRequest.read',
  'GET /api/hr/teams 200 team.read',
  'GET /api/hr/teams/:id 200 team.read',
  'GET /api/hr/work-calendar 200 workCalendar.read',
  'GET /api/hr/work-calendar/schedule 200 workCalendar.read',
  'GET /api/openapi.json 200 public',
  'PATCH /api/hr/employees/:id 200 employee.update',
  'PATCH /api/hr/teams/:id 200 team.update',
  'POST /api/administration/accounts 201 account.provision',
  'POST /api/administration/accounts/:id/boundaries 200 account.bindBoundary',
  'POST /api/administration/accounts/:id/google/reset 200 account.resetGoogleBinding',
  'POST /api/administration/accounts/:id/mfa/reset 200 account.resetMfa',
  'POST /api/administration/accounts/:id/roles 200 account.assignRole',
  'POST /api/administration/roles 201 role.create',
  'POST /api/administration/users/:id/reactivate 200 account.reactivate',
  'POST /api/administration/users/:id/suspend 200 account.suspend',
  'POST /api/auth/logout 200 authenticated',
  'POST /api/auth/logout-all 200 authenticated',
  'POST /api/auth/mfa/recovery-codes 200 authenticated',
  'POST /api/auth/mfa/totp/confirm 200 authenticated',
  'POST /api/auth/mfa/totp/setup 200 authenticated',
  'POST /api/auth/mfa/verify 200 authenticated',
  'POST /api/auth/oidc/activate 200 public',
  'POST /api/auth/oidc/begin 200 public',
  'POST /api/hr/attendance/periods/:month/close 200 hrCompany.managePeriod',
  'POST /api/hr/attendance/periods/:month/reopen 200 hrCompany.managePeriod',
  'POST /api/hr/employees 201 hrCompany.createEmployee',
  'POST /api/hr/employees/:id/attendance-adjustments 201 employee.adjustAttendance',
  'POST /api/hr/employees/:id/leave-adjustments 201 employee.adjustLeaveBalance',
  'POST /api/hr/employees/:id/leave-rates 201 employee.adjustLeaveRate',
  'POST /api/hr/employees/:id/official 200 employee.update',
  'POST /api/hr/employees/:id/schedule-frames 201 employee.manageSchedule',
  'POST /api/hr/employees/:id/termination 200 employee.update',
  'POST /api/hr/requests 201 employee.submitRequest',
  'POST /api/hr/requests/:id/cancel 200 authenticated',
  'POST /api/hr/requests/:id/decision 200 authenticated',
  'POST /api/hr/teams 201 hrCompany.createTeam',
  'POST /api/hr/teams/:id/members 200 team.assign',
  'POST /api/hr/teams/:id/members/:employeeId/primary 200 team.assign',
  'PUT /api/administration/accounts/:id/email 200 account.changeEmail',
  'PUT /api/administration/roles/:key 200 role.update',
  'PUT /api/administration/settings/profile/:key 200 setting.updateProfile',
  'PUT /api/administration/settings/rule/:key 200 setting.updateRule',
  'PUT /api/hr/employees/:id/account 200 employee.linkAccount',
  'PUT /api/hr/employees/:id/identity 200 employeeIdentity.update',
  'PUT /api/hr/teams/:id/lead 200 team.assign',
  'PUT /api/hr/work-calendar/days/:date 200 workCalendar.manage',
  'PUT /api/hr/work-calendar/holidays 200 workCalendar.manage',
  'PUT /api/hr/work-calendar/schedule/:effectiveFrom 200 workCalendar.manageSchedule',
];

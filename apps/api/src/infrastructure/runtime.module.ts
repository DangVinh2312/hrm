import { ReadinessGate } from '../health/services/readiness.service.js';
import { Module, ServiceUnavailableException, type DynamicModule } from '@nestjs/common';
import {
  ADMINISTRATION_HTTP_PORT,
  type AdministrationHttpPort,
} from '../administration/administration.http-port.js';
import { AUTH_HTTP_PORT, type AuthHttpPort } from '../auth/auth.http-port.js';
import { DOCUMENT_HTTP_PORT, type DocumentHttpPort } from '../document/document.http-port.js';
import { EMPLOYEE_HTTP_PORT, type EmployeeHttpPort } from '../employee/employee.http-port.js';
import { HR_HTTP_PORT, type HrHttpPort } from '../hr/hr.http-port.js';
import { TEAM_HTTP_PORT, type TeamHttpPort } from '../team/team.http-port.js';
import {
  WORK_CALENDAR_HTTP_PORT,
  type WorkCalendarHttpPort,
} from '../work-calendar/work-calendar.http-port.js';
import {
  WORK_REQUEST_HTTP_PORT,
  type WorkRequestHttpPort,
} from '../work-request/work-request.http-port.js';
import {
  METRICS_SNAPSHOT,
  type MetricsSnapshot,
} from '../health/services/product-metrics.service.js';
import { ProductRuntime } from './product-runtime.service.js';
import { ProductAuthenticationError } from '../auth/services/product-identity.service.js';

/**
 * Owns the runtime (pools, release, transaction runner) as a private provider so Nest runs its
 * bootstrap/shutdown hooks; feature modules import this module and see only the exported facades
 * of bound operations. Never global, never exports ProductRuntime.
 */
@Module({})
export class RuntimeModule {
  static register(runtime: ProductRuntime): DynamicModule {
    const {
      authorization,
      identity,
      oidc,
      mfa,
      metrics,
      employees,
      teams,
      workCalendar,
      workRequests,
      approvals,
    } = runtime;
    const config = { origin: runtime.config.origin };
    const providers = runtime.config.oidcProviders;
    // shortcut: email provisioning targets the deployment's single OIDC provider; with several
    // providers it is unavailable (503) until the request names an allowlisted issuer.
    const provisioningIssuer = providers.length === 1 ? providers[0]?.issuer : undefined;
    // Factories rather than values: Nest hashes module metadata, which must not walk the pools.
    return {
      module: RuntimeModule,
      providers: [
        {
          provide: ProductRuntime,
          useFactory: () => runtime,
        },
        {
          provide: ReadinessGate,
          useFactory: () => runtime.readiness,
        },
        {
          provide: METRICS_SNAPSHOT,
          useFactory: (): MetricsSnapshot => ({ snapshot: metrics.snapshot.bind(metrics) }),
        },
        {
          provide: AUTH_HTTP_PORT,
          useFactory: (): AuthHttpPort => ({
            config,
            identity: { logout: identity.logout.bind(identity) },
            oidc: {
              begin: oidc.begin.bind(oidc),
              callback: async (...args) => {
                try {
                  return { kind: 'authenticated', session: await oidc.callback(...args) };
                } catch (error) {
                  if (error instanceof ProductAuthenticationError) return { kind: 'failed' };
                  throw error;
                }
              },
              ownAccount: oidc.ownAccount.bind(oidc),
            },
            mfa: {
              status: mfa.status.bind(mfa),
              setup: mfa.setup.bind(mfa),
              confirm: mfa.confirm.bind(mfa),
              verify: mfa.verify.bind(mfa),
              regenerateRecoveryCodes: mfa.regenerateRecoveryCodes.bind(mfa),
              remove: mfa.remove.bind(mfa),
            },
            currentSession: runtime.currentSession.bind(runtime),
            menus: async (secret) =>
              (await authorization.permits(secret, 'account', 'read')) ? ['accounts'] : [],
          }),
        },
        {
          provide: DOCUMENT_HTTP_PORT,
          useFactory: (): DocumentHttpPort => ({
            config,
            list: (secret) => authorization.list(secret, 'document', 'read'),
            detail: (secret, id) => authorization.detail(secret, 'document', 'read', id),
            update: (secret, id, changes) =>
              authorization.update(secret, 'document', 'update', id, changes),
          }),
        },
        {
          provide: ADMINISTRATION_HTTP_PORT,
          useFactory: (): AdministrationHttpPort => ({
            config,
            suspendUser: authorization.suspendUser.bind(authorization),
            provisionAccount: (secret, email) =>
              provisioningIssuer === undefined
                ? Promise.reject(new ServiceUnavailableException())
                : authorization.provisionAccount(secret, email, provisioningIssuer),
            listAccounts: (secret, page) =>
              authorization.list(secret, 'account', 'read', { ...page, orderBy: 'email' }),
          }),
        },
        {
          provide: HR_HTTP_PORT,
          useFactory: (): HrHttpPort => ({
            config,
            me: async (secret) => {
              const session = await runtime.currentSession(secret);
              return { userId: session.userId, ...(await employees.me(secret)) };
            },
          }),
        },
        {
          provide: EMPLOYEE_HTTP_PORT,
          useFactory: (): EmployeeHttpPort => ({
            config,
            list: employees.list.bind(employees),
            detail: employees.detail.bind(employees),
            create: employees.create.bind(employees),
            update: employees.update.bind(employees),
            confirmOfficial: employees.confirmOfficial.bind(employees),
            terminate: employees.terminate.bind(employees),
            identity: employees.identity.bind(employees),
            updateIdentity: employees.updateIdentity.bind(employees),
            leaveRates: employees.leaveRates.bind(employees),
            adjustLeaveRate: employees.adjustLeaveRate.bind(employees),
            linkAccount: employees.linkAccount.bind(employees),
          }),
        },
        {
          provide: TEAM_HTTP_PORT,
          useFactory: (): TeamHttpPort => ({
            config,
            list: teams.list.bind(teams),
            detail: teams.detail.bind(teams),
            create: teams.create.bind(teams),
            rename: teams.rename.bind(teams),
            addMember: teams.addMember.bind(teams),
            setPrimary: teams.setPrimary.bind(teams),
            endMembership: teams.endMembership.bind(teams),
            assignLead: teams.assignLead.bind(teams),
          }),
        },
        {
          provide: WORK_CALENDAR_HTTP_PORT,
          useFactory: (): WorkCalendarHttpPort => ({
            config,
            year: workCalendar.year.bind(workCalendar),
            setDay: workCalendar.setDay.bind(workCalendar),
          }),
        },
        {
          provide: WORK_REQUEST_HTTP_PORT,
          useFactory: (): WorkRequestHttpPort => ({
            config,
            submit: workRequests.submit.bind(workRequests),
            list: workRequests.list.bind(workRequests),
            detail: workRequests.detail.bind(workRequests),
            decide: approvals.decide.bind(approvals),
            leadQueue: approvals.leadQueue.bind(approvals),
            finalQueue: approvals.finalQueue.bind(approvals),
            decided: approvals.decided.bind(approvals),
          }),
        },
      ],
      exports: [
        ReadinessGate,
        METRICS_SNAPSHOT,
        AUTH_HTTP_PORT,
        DOCUMENT_HTTP_PORT,
        ADMINISTRATION_HTTP_PORT,
        HR_HTTP_PORT,
        EMPLOYEE_HTTP_PORT,
        TEAM_HTTP_PORT,
        WORK_CALENDAR_HTTP_PORT,
        WORK_REQUEST_HTTP_PORT,
      ],
    };
  }
}

import { ProductMetrics } from '../health/services/product-metrics.service.js';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ReadinessGate } from '../health/services/readiness.service.js';
import {
  type ProductReleaseManifest,
  ProductManifestReconciler,
} from '../authorization/services/product-manifest.service.js';
import {
  type ProductSessionIdentity,
  ProductIdentityService,
} from '../authentication/services/product-identity.service.js';
import { ProductTransactionRunner } from '../database/product-transaction.runner.js';

import { ProductAuthorization } from '../authorization/services/product-authority.service.js';
import { ProductAccountService } from '../authorization/services/product-account.service.js';
import { AccountBoundaryService } from '../authorization/services/account-boundary.service.js';
import { ProductIdentityOperationService } from '../authorization/services/product-identity-operation.service.js';
import { ProductBindingRegistry } from '../authorization/product-sql.compiler.js';

import { ProductOidcService } from '../authentication/services/product-oidc.service.js';
import { createProductOidcProvider } from '../authentication/services/product-oidc-provider.service.js';
import { ProductMfaService } from '../authentication/services/product-mfa.service.js';
import { verifyProductPrivileges } from '../database/services/product-privilege-verify.service.js';
import { createProductObligations } from '../authorization/services/product-obligation.service.js';
import {
  PRODUCT_OFFLINE_ACTOR,
  ProductAuditRepository,
} from '../audit/product-audit.repository.js';
import type { AuthorizationCore } from '../authorization/core/authorization.factory.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../authorization/product.manifest.js';
import type { AppConfig } from '../config/app.config.js';
import { permissionPrivileges } from '../modules/permission/permission-database.helper.js';
import type { PermissionObjectRepository } from '../modules/permission/permission-object.repository.js';
import {
  verifyPermissionProtection,
  verifySettingSchema,
  verifyWorkCalendarSchema,
} from '../modules/permission/services/permission-protection-verify.service.js';
import { createProductModules } from './product-modules.factory.js';
import type { EmployeeService } from '../modules/employee/employee.service.js';
import type { TeamService } from '../modules/team/team.service.js';
import type { WorkCalendarService } from '../modules/work-calendar/work-calendar.service.js';
import type { WorkRequestService } from '../modules/work-request/services/work-request.service.js';
import type { RequestApprovalService } from '../modules/work-request/services/request-approval.service.js';
import type { RequestCancelService } from '../modules/work-request/services/request-cancel.service.js';
import type { LeaveService } from '../modules/leave/leave.service.js';
import type { AttendanceService } from '../modules/attendance/attendance.service.js';
import type { ReportService } from '../modules/report/services/report.service.js';
import type { RoleService } from '../modules/role/role.service.js';
import type { SettingService } from '../modules/setting/setting.service.js';

export class ProductRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly readiness = new ReadinessGate();
  readonly authorization: ProductAuthorization;
  readonly accounts: ProductAccountService;
  readonly accountBoundaries: AccountBoundaryService;
  readonly identityOperations: ProductIdentityOperationService;
  readonly identity: ProductIdentityService;
  readonly oidc: ProductOidcService;
  readonly mfa: ProductMfaService;
  readonly release: ProductReleaseManifest;
  readonly employees: EmployeeService;
  readonly teams: TeamService;
  readonly workCalendar: WorkCalendarService;
  readonly workRequests: WorkRequestService;
  readonly approvals: RequestApprovalService;
  readonly cancellations: RequestCancelService;
  readonly leave: LeaveService;
  readonly attendance: AttendanceService;
  readonly reports: ReportService;
  readonly roles: RoleService;
  readonly settings: SettingService;
  private readonly permissionObject: PermissionObjectRepository;

  private constructor(
    readonly config: AppConfig,
    private readonly core: AuthorizationCore,
    private readonly pools: Record<'data' | 'identity' | 'authority' | 'sync', DataSource>,
    private readonly runner: ProductTransactionRunner,
    private readonly audit: ProductAuditRepository,
    identity: ProductIdentityService,
    oidc: ProductOidcService,
    readonly metrics = new ProductMetrics(),
  ) {
    this.identity = identity;
    this.oidc = oidc;
    this.mfa = new ProductMfaService(identity, config.mfaKeys);
    this.release = createProductRelease(core);
    // Repositories, the commands over them and the services are created once here, then passed down.
    const modules = createProductModules();
    this.permissionObject = modules.repositories.permissionObject;
    const obligations = createProductObligations(audit);
    const bindings = new ProductBindingRegistry(core, this.release.declarations, productBindings);
    this.authorization = new ProductAuthorization(
      runner,
      audit,
      bindings,
      {
        validators: { 'fresh@1': (_params, input) => input.context.freshAuthentication === true },
        obligations,
      },
      // No writable-field allowlist: `document` has no HTTP route, so the generic
      // `update` stays disabled in the API process; tests pass their own.
      [],
      modules.commands,
      modules.queries,
    );
    this.accounts = new ProductAccountService(this.authorization, audit, bindings);
    this.accountBoundaries = new AccountBoundaryService(this.authorization, audit, bindings);
    this.identityOperations = new ProductIdentityOperationService(
      this.authorization,
      audit,
      bindings,
    );
    const services = modules.bindServices(this.authorization);
    this.teams = services.teams;
    this.employees = services.employees;
    this.workCalendar = services.workCalendar;
    this.workRequests = services.workRequests;
    this.approvals = services.approvals;
    this.cancellations = services.cancellations;
    this.leave = services.leave;
    this.attendance = services.attendance;
    this.reports = services.reports;
    this.roles = services.roles;
    this.settings = services.settings;
  }

  static async create(config: AppConfig): Promise<ProductRuntime> {
    // Codecs are chosen before any pool opens: a missing/invalid codec fails before the listener.
    const core = createProductAuthorizationCore();
    const pools = {} as Record<'data' | 'identity' | 'authority' | 'sync', DataSource>;
    try {
      for (const purpose of ['data', 'identity', 'authority', 'sync'] as const)
        pools[purpose] = await new DataSource({
          type: 'postgres',
          url: config.databases[purpose].href,
          synchronize: false,
          migrationsRun: false,
          logging: false,
          ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: true } : false,
          extra: {
            max: purpose === 'data' ? 5 : purpose === 'sync' ? 1 : 2,
            connectionTimeoutMillis: 2000,
          },
        }).initialize();
      // Offline capabilities are absent from the HTTP process.
      const metrics = new ProductMetrics();
      const runner = new ProductTransactionRunner(pools, { onMetric: metrics.observe });
      const audit = new ProductAuditRepository();
      const identity = new ProductIdentityService(runner, audit);
      const providers = new Map();
      for (const settings of config.oidcProviders)
        providers.set(settings.issuer, await createProductOidcProvider(settings));
      return new ProductRuntime(
        config,
        core,
        pools,
        runner,
        audit,
        identity,
        new ProductOidcService(identity, providers),
        metrics,
      );
    } catch (error) {
      await Promise.all(Object.values(pools).map((p) => p.destroy()));
      throw error;
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    // Exact grants, including those of the application document and HR migrations.
    await verifyProductPrivileges(this.pools, {
      data: ['table:document:SELECT', 'column:document.title:UPDATE', ...permissionPrivileges.data],
      authority: ['table:document:SELECT', ...permissionPrivileges.authority],
      sync: [...permissionPrivileges.sync],
    });
    await verifyPermissionProtection(this.pools.data);
    // A stored secret under a key this process lacks fails the boot, not a login.
    await this.mfa.verifyKeyCoverage();
    await new ProductManifestReconciler(this.runner, this.audit, {
      core: this.core,
      actor: PRODUCT_OFFLINE_ACTOR,
      capabilities: {
        validators: ['fresh@1'],
        obligationHandlers: Object.keys(createProductObligations(this.audit)),
      },
    }).reconcile(this.release);
    await this.runner.run('sync', async (tx) => {
      const declared = this.config.oidcProviders.map((p) => p.issuer);
      const existing = await tx.manager.query<
        { issuer: string; version: string; enabled: boolean }[]
      >('SELECT issuer,version::text version,enabled FROM oidc_provider');
      if (existing.some((p) => p.enabled && !declared.includes(p.issuer)))
        throw new Error('Provider disable requires explicit offline revoke');
      for (const provider of this.config.oidcProviders) {
        const current = existing.find((p) => p.issuer === provider.issuer);
        if (current && (current.version !== provider.version || !current.enabled))
          throw new Error('Provider drift requires explicit release');
        if (!current) {
          await tx.manager.query(
            'INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,$2,true)',
            [provider.issuer, provider.version],
          );
          await tx.manager.query('UPDATE authz_state SET revision=revision+1 WHERE singleton');
        }
      }
    });
    // Code-owned anchor of company-level creates; needs the hrCompany type the sync just applied.
    await this.runner.run('sync', (tx) => this.permissionObject.ensureCompany(tx));
    await this.runner.run('sync', (tx) => this.permissionObject.ensureWorkCalendar(tx));
    await this.runner.run('sync', (tx) => this.permissionObject.ensureSetting(tx));
    await this.runner.run('sync', (tx) => this.permissionObject.ensureRole(tx));
    // A declared resource without its application migration must prevent the listener from opening.
    await this.pools.data.query('SELECT id,title,owner_id,state,object_id FROM document LIMIT 0');
    await this.pools.data.query(
      'SELECT e.id,e.object_id,e.code,e.full_name,e.account_id,e.hired_on,e.terminated_on,e.job_position,e.classification,t.id,t.object_id,t.name,t.version,r.id,r.object_id,r.kind,r.state,r.version FROM employee e,team t,work_request r LIMIT 0',
    );
    await this.pools.data.query(
      'SELECT i.employee_id,i.object_id,i.gender,i.phone,i.work_email,p.employee_id,p.status,l.id,l.object_id,l.annual_minutes,c.id,c.object_id FROM employee_identity i,employment_status_period p,leave_rate l,hr_company c LIMIT 0',
    );
    await this.pools.data.query(
      'SELECT w.id,w.object_id,w.version,x.version,x.day,x.kind,x.name FROM work_calendar w,work_calendar_change x LIMIT 0',
    );
    await this.pools.data.query(
      'SELECT r.reason,s.request_id,s.kind,s.work_date,s.start_minute,s.end_minute,s.minutes,i.actor_id,i.operation,i.key,i.payload_hash,i.target_id,i.result,d.reason FROM work_request r,work_request_segment s,hr_idempotency i,request_decision d LIMIT 0',
    );
    await this.pools.data.query(
      'SELECT a.id,a.object_id,a.version,s.key,s.value,s.version,s.updated_at,s.updated_by,h.key,h.version,h.old_value,h.new_value,h.changed_by,h.changed_at FROM setting_anchor a,system_setting s,system_setting_history h LIMIT 0',
    );
    await this.pools.data.query('SELECT a.id,a.object_id FROM role_anchor a LIMIT 0');
    await verifyWorkCalendarSchema(this.pools.data);
    await verifySettingSchema(this.pools.data);
    this.readiness.markReady();
  }

  #closed: Promise<unknown> | undefined;

  /** Idempotent (TypeORM destroy() throws when repeated): main.ts and Nest's shutdown hook may both call it. */
  async onApplicationShutdown(): Promise<void> {
    // A rejection is memoized too: retrying destroy() on half-closed pools would only throw again.
    this.#closed ??= Promise.all(Object.values(this.pools).map((p) => p.destroy()));
    await this.#closed;
  }

  async currentSession(secret: string): Promise<ProductSessionIdentity> {
    return this.runner.run('identity', (tx) => this.identity.authenticate(tx, secret));
  }
}

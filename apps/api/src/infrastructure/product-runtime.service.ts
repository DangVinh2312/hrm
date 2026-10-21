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
} from '../auth/services/product-identity.service.js';
import { ProductTransactionRunner } from '../database/product-transaction.runner.js';

import { ProductAuthorization } from '../authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../authorization/product-sql.compiler.js';

import { ProductOidcService } from '../auth/services/product-oidc.service.js';
import { createProductOidcProvider } from '../auth/services/product-oidc-provider.service.js';
import { ProductMfaService } from '../auth/services/product-mfa.service.js';
import { verifyProductPrivileges } from '../database/helpers/product-database.helper.js';
import { productObligations } from '../authorization/helpers/product-obligations.helper.js';
import { PRODUCT_OFFLINE_ACTOR } from '../audit/product-audit.repository.js';
import type { AuthorizationCore } from '../authorization/core/authorization.factory.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../authorization/product.manifest.js';
import type { AppConfig } from '../config/app.config.js';
import {
  ensureHrCompany,
  ensureWorkCalendar,
  hrPrivileges,
  verifyHrProtection,
  verifyWorkCalendarSchema,
} from '../hr/hr-database.helper.js';
import {
  EmployeeService,
  employeeCommands,
  employeeQueries,
} from '../employee/employee.service.js';
import { TeamService, teamCommands, teamQueries } from '../team/team.service.js';
import {
  WorkCalendarService,
  workCalendarCommands,
  workCalendarQueries,
} from '../work-calendar/work-calendar.service.js';
import {
  WorkRequestService,
  workRequestCommands,
  workRequestQueries,
} from '../work-request/services/work-request.service.js';
import {
  RequestApprovalService,
  approvalCommands,
  approvalQueries,
} from '../work-request/services/request-approval.service.js';
import { LeaveService, leaveQueries } from '../leave/leave.service.js';
import {
  AttendanceService,
  attendanceCommands,
  attendanceQueries,
} from '../attendance/attendance.service.js';

/**
 * Commands and queries fixed at composition (ADR 0016 §1). Exported so tests check the registered
 * set itself, e.g. that every `admin` command's policy requires `fresh@1` (ADR 0022 §1).
 */
export const productCommands = [
  ...employeeCommands,
  ...teamCommands,
  ...workCalendarCommands,
  ...workRequestCommands,
  ...approvalCommands,
  ...attendanceCommands,
] as const;

export const productQueries = [
  ...employeeQueries,
  ...teamQueries,
  ...workCalendarQueries,
  ...workRequestQueries,
  ...approvalQueries,
  ...leaveQueries,
  ...attendanceQueries,
] as const;

export class ProductRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly readiness = new ReadinessGate();
  readonly authorization: ProductAuthorization;
  readonly identity: ProductIdentityService;
  readonly oidc: ProductOidcService;
  readonly mfa: ProductMfaService;
  readonly release: ProductReleaseManifest;
  readonly employees: EmployeeService;
  readonly teams: TeamService;
  readonly workCalendar: WorkCalendarService;
  readonly workRequests: WorkRequestService;
  readonly approvals: RequestApprovalService;
  readonly leave: LeaveService;
  readonly attendance: AttendanceService;

  private constructor(
    readonly config: AppConfig,
    private readonly core: AuthorizationCore,
    private readonly pools: Record<'data' | 'identity' | 'authority' | 'sync', DataSource>,
    private readonly runner: ProductTransactionRunner,
    identity: ProductIdentityService,
    oidc: ProductOidcService,
    readonly metrics = new ProductMetrics(),
  ) {
    this.identity = identity;
    this.oidc = oidc;
    this.mfa = new ProductMfaService(identity, config.mfaKeys);
    this.release = createProductRelease(core);
    this.authorization = new ProductAuthorization(
      runner,
      new ProductBindingRegistry(core, this.release.declarations, productBindings),
      {
        validators: { 'fresh@1': (_params, input) => input.context.freshAuthentication === true },
        obligations: productObligations,
      },
      [{ resource: 'document', action: 'update', fields: ['title'] }],
      productCommands,
      productQueries,
    );
    this.teams = new TeamService(this.authorization);
    this.employees = new EmployeeService(this.authorization);
    this.workCalendar = new WorkCalendarService(this.authorization);
    this.workRequests = new WorkRequestService(this.authorization);
    this.approvals = new RequestApprovalService(this.authorization);
    this.leave = new LeaveService(this.authorization);
    this.attendance = new AttendanceService(this.authorization);
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
      const identity = new ProductIdentityService(runner);
      const providers = new Map();
      for (const settings of config.oidcProviders)
        providers.set(settings.issuer, await createProductOidcProvider(settings));
      return new ProductRuntime(
        config,
        core,
        pools,
        runner,
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
      data: ['table:document:SELECT', 'column:document.title:UPDATE', ...hrPrivileges.data],
      authority: ['table:document:SELECT', ...hrPrivileges.authority],
      sync: [...hrPrivileges.sync],
    });
    await verifyHrProtection(this.pools.data);
    // ADR 0026 §3: a stored secret under a key this process lacks fails the boot, not a login.
    await this.mfa.verifyKeyCoverage();
    await new ProductManifestReconciler(this.runner, {
      core: this.core,
      actor: PRODUCT_OFFLINE_ACTOR,
      capabilities: {
        validators: ['fresh@1'],
        obligationHandlers: Object.keys(productObligations),
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
    await this.runner.run('sync', (tx) => ensureHrCompany(tx));
    await this.runner.run('sync', (tx) => ensureWorkCalendar(tx));
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
    await verifyWorkCalendarSchema(this.pools.data);
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

import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { UserId } from '../dist/authorization/core/authorization.types.js';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import { ProductAccountService } from '../dist/authorization/services/product-account.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../dist/authorization/product.manifest.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { bootstrapActiveRoot, bindAccount, oidcSession } from './oidc-fixture.helper.ts';
import { productDataSourceOptions } from '../dist/database/helpers/product-database.helper.js';
import {
  type ProductModules,
  type ProductModuleServices,
  createProductModules,
} from '../dist/infrastructure/product-modules.factory.js';
import type { ApprovedEffects } from '../dist/modules/work-request/services/request-approval.service.js';
import type { EmployeeService } from '../dist/modules/employee/employee.service.js';
import type { TeamService } from '../dist/modules/team/team.service.js';
import type { WorkCalendarService } from '../dist/modules/work-calendar/work-calendar.service.js';
import type { WorkRequestService } from '../dist/modules/work-request/services/work-request.service.js';
import type { RequestApprovalService } from '../dist/modules/work-request/services/request-approval.service.js';
import type { RequestCancelService } from '../dist/modules/work-request/services/request-cancel.service.js';
import type { LeaveService } from '../dist/modules/leave/leave.service.js';
import type { AttendanceService } from '../dist/modules/attendance/attendance.service.js';
import type { ReportService } from '../dist/modules/report/services/report.service.js';
import type { RoleService } from '../dist/modules/role/role.service.js';
import type { SettingService } from '../dist/modules/setting/setting.service.js';
import { moduleTemplate, productConnections } from './module-template.helper.ts';
import { startPostgres, type TestPostgres } from './setup-postgres.ts';

/** An IAM account with a plain session and a freshly reauthenticated one (synthetic data). */
export interface ModulePerson {
  readonly id: UserId;
  readonly secret: string;
  readonly fresh: string;
}

export interface ModuleStack {
  readonly postgres: TestPostgres;
  readonly pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
  /** Owner login, for assertions on rows the runtime logins cannot read. */
  readonly migration: DataSource;
  readonly runner: ProductTransactionRunner;
  readonly authorization: ProductAuthorization;
  readonly accounts: ProductAccountService;
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
  /** The registered final-decision command (the gated one when `effects` was given). */
  readonly finalDecision: ProductModules['finalDecision'];
  /** The composition (repositories, registered commands) shared with ProductRuntime. */
  readonly modules: ProductModules;
  readonly rootId: UserId;

  person(roles: readonly string[]): Promise<ModulePerson>;

  /** A new Root session without step-up. */
  root(): Promise<string>;

  /** A new Root session with a step-up 5 s ago (write/admin need < 300 s, ADR 0012). */
  freshRoot(): Promise<string>;

  /** Business date `YYYY-MM-DD` today ± days, from the DB clock in Asia/Ho_Chi_Minh. */
  day(offset: number): Promise<string>;

  /** The latest Monday–Friday on or before today (DB clock, business timezone). */
  latestWeekday(): Promise<string>;

  /** The first Monday–Friday of `month` (`YYYY-MM`) other than `not`, by the database calendar. */
  otherWeekday(month: string, not: string): Promise<string>;

  revision(): Promise<string>;

  stop(): Promise<void>;
}

const utf8 = (value: string) => Buffer.from(value, 'utf8');

const rootEmail = 'root@example.test';

/**
 * Disposable PostgreSQL with every product + HR migration, release 7 synced, the company and calendar anchors
 * and an OIDC Root (ADR 0027: Google only). The composition mirrors ProductRuntime: same
 * commands, queries and services.
 */
export async function startModuleStack(options: StackOptions = {}): Promise<ModuleStack> {
  // Shared container + cloned template when tools/test.ts provides one; otherwise an own container
  // that builds the same template in place (direct `node --test` keeps working).
  const postgres = await startPostgres({ shared: !options.isolated, template: moduleTemplate });
  const opened: DataSource[] = [];
  try {
    return await buildModuleStack(postgres, opened, options);
  } catch (error) {
    // A failed setup must not leak the container or pools, nor hide the original error.
    for (const source of opened) await source.destroy().catch(() => undefined);
    await postgres.stop().catch(() => undefined);
    throw error;
  }
}

/**
 * `effects`: a stand-in effect set for tests of the approval effects themselves (the production
 * set keeps every approval closed until T8). Without it the stack registers the production
 * commands, exactly like ProductRuntime.
 */
export interface StackOptions {
  /** Own container (no neighbours on the cluster): for timing measurements. */
  readonly isolated?: boolean;
  readonly effects?: ApprovedEffects;
}

async function buildModuleStack(
  postgres: TestPostgres,
  opened: DataSource[],
  options: StackOptions,
): Promise<ModuleStack> {
  const modules = createProductModules({ effects: options.effects });
  const audit = new ProductAuditRepository();
  const core = createProductAuthorizationCore();
  const release = createProductRelease(core);
  const connections = productConnections(postgres);
  const pools = {} as ModuleStack['pools'];
  for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const) {
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
    opened.push(pools[purpose]);
  }
  const migration = await new DataSource(
    productDataSourceOptions(connections.migration),
  ).initialize();
  opened.push(migration);
  const runner = new ProductTransactionRunner(pools);
  const bindings = new ProductBindingRegistry(core, release.declarations, productBindings);
  const authorization = new ProductAuthorization(
    runner,
    audit,
    bindings,
    {
      validators: {
        'fresh@1': (_params, input) => input.context.freshAuthentication === true,
      },
      obligations: createProductObligations(audit),
    },
    [],
    modules.commands,
    modules.queries,
  );
  const services: ProductModuleServices = modules.bindServices(authorization);

  const { userId: rootId } = await bootstrapActiveRoot(runner, release, pools.identity, rootEmail);

  return {
    postgres,
    pools,
    migration,
    runner,
    authorization,
    accounts: new ProductAccountService(authorization, audit, bindings),
    ...services,
    modules,
    finalDecision: modules.finalDecision,
    rootId,
    person: async (roles) => {
      const id = randomUUID() as UserId;
      await migration.query(
        `INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true)`,
        [id],
      );
      await bindAccount(pools.identity, id);
      const secrets = [
        await oidcSession(pools.identity, id),
        await oidcSession(pools.identity, id, { fresh: true }),
      ];
      if (roles.length)
        await runner.run('admin', async (tx) => {
          for (const role of roles)
            await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
              id,
              utf8(role),
            ]);
        });
      return { id, secret: secrets[0]!, fresh: secrets[1]! };
    },
    root: () => oidcSession(pools.identity, rootId),
    freshRoot: () => oidcSession(pools.identity, rootId, { fresh: true }),
    day: async (offset) => {
      const [row] = await migration.query<{ day: string }[]>(
        `SELECT to_char((statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + CAST($1 AS int),'YYYY-MM-DD') AS day`,
        [offset],
      );
      return row!.day;
    },
    latestWeekday: async () => {
      const [row] = await migration.query<{ day: string }[]>(
        `SELECT to_char(d,'YYYY-MM-DD') AS day
           FROM generate_series((statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 6,
                                (statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, interval '1 day') AS g(d)
          WHERE EXTRACT(isodow FROM d) < 6 ORDER BY d DESC LIMIT 1`,
      );
      return row!.day;
    },
    otherWeekday: async (month, not) => {
      const [row] = await migration.query<{ day: string }[]>(
        `SELECT to_char(d,'YYYY-MM-DD') AS day
           FROM generate_series(CAST($1 || '-01' AS date), CAST($1 || '-01' AS date) + 27, interval '1 day') AS g(d)
          WHERE EXTRACT(isodow FROM d) < 6 AND d <> CAST($2 AS date) ORDER BY d LIMIT 1`,
        [month, not],
      );
      return row!.day;
    },
    revision: async () =>
      (
        await migration.query<{ revision: string }[]>(
          'SELECT revision::text AS revision FROM authz_state WHERE singleton',
        )
      )[0]!.revision,
    stop: async () => {
      await migration.destroy();
      for (const pool of Object.values(pools)) await pool.destroy();
      await postgres.stop();
    },
  };
}

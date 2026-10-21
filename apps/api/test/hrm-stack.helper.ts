import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId, UserId } from '../dist/authorization/core/authorization.types.js';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../dist/authorization/product.manifest.js';
import { productObligations } from '../dist/authorization/helpers/product-obligations.helper.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  bootstrapActiveRoot,
  bindAccount,
  fixtureProvider,
  oidcSession,
} from './oidc-fixture.helper.ts';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  productMigrations,
  provisionProductDatabase,
} from '../dist/database/helpers/product-database.helper.js';
import { HrmAuthorization1792108800100 } from '../dist/modules/hr/migrations/hrm-authorization.migration.js';
import { HrmEmployee1792108800101 } from '../dist/modules/employee/migrations/hrm-employee.migration.js';
import { HrmTeam1792108800102 } from '../dist/modules/team/migrations/hrm-team.migration.js';
import { HrmWorkCalendar1792108800103 } from '../dist/modules/work-calendar/migrations/hrm-work-calendar.migration.js';
import { HrmWorkCalendarMakeup1792108800104 } from '../dist/modules/work-calendar/migrations/hrm-work-calendar-makeup.migration.js';
import { HrmEmployeeProfile1792108800105 } from '../dist/modules/employee/migrations/hrm-employee-profile.migration.js';
import { HrmWorkRequest1792108800106 } from '../dist/modules/work-request/migrations/hrm-work-request.migration.js';
import { HrmRequestApproval1792108800107 } from '../dist/modules/work-request/migrations/hrm-request-approval.migration.js';
import { HrmRequestLeadRejected1792108800108 } from '../dist/modules/work-request/migrations/hrm-request-lead-rejected.migration.js';
import { HrmLeave1792108800109 } from '../dist/modules/leave/migrations/hrm-leave.migration.js';
import { HrmAttendance1792108800110 } from '../dist/modules/attendance/migrations/hrm-attendance.migration.js';
import { HrmRequestCancel1792108800111 } from '../dist/modules/work-request/migrations/hrm-request-cancel.migration.js';
import {
  ensureHrCompany,
  ensureWorkCalendar,
} from '../dist/modules/hr/helpers/hr-database.helper.js';
import {
  EmployeeService,
  employeeCommands,
  employeeQueries,
} from '../dist/modules/employee/employee.service.js';
import { TeamService, teamCommands, teamQueries } from '../dist/modules/team/team.service.js';
import {
  WorkCalendarService,
  workCalendarCommands,
  workCalendarQueries,
} from '../dist/modules/work-calendar/work-calendar.service.js';
import {
  WorkRequestService,
  createSubmitRequest,
  workRequestCommands,
  workRequestQueries,
} from '../dist/modules/work-request/services/work-request.service.js';
import {
  RequestCancelService,
  cancelCommands,
  cancelQueries,
} from '../dist/modules/work-request/services/request-cancel.service.js';
import {
  type ApprovedEffects,
  RequestApprovalService,
  approvalCommands,
  approvalQueries,
  createApprovalCommands,
  finalDecision,
} from '../dist/modules/work-request/services/request-approval.service.js';
import { LeaveService, leaveCommands, leaveQueries } from '../dist/modules/leave/leave.service.js';
import {
  AttendanceService,
  attendanceCommands,
  attendanceQueries,
} from '../dist/modules/attendance/attendance.service.js';
import { ReportService, reportQueries } from '../dist/modules/report/report.service.js';
import { startPostgres, type TestPostgres } from './setup-postgres.ts';

/** An IAM account with a plain session and a freshly reauthenticated one (synthetic data). */
export interface HrPerson {
  readonly id: UserId;
  readonly secret: string;
  readonly fresh: string;
}

export interface HrStack {
  readonly postgres: TestPostgres;
  readonly pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
  /** Owner login, for assertions on rows the runtime logins cannot read. */
  readonly migration: DataSource;
  readonly runner: ProductTransactionRunner;
  readonly authorization: ProductAuthorization;
  readonly employees: EmployeeService;
  readonly teams: TeamService;
  readonly workCalendar: WorkCalendarService;
  readonly workRequests: WorkRequestService;
  readonly approvals: RequestApprovalService;
  readonly cancellations: RequestCancelService;
  readonly leave: LeaveService;
  readonly attendance: AttendanceService;
  readonly reports: ReportService;
  /** The registered final-decision command (the gated one when `effects` was given). */
  readonly finalDecision: typeof finalDecision;
  readonly rootId: UserId;

  person(roles: readonly string[]): Promise<HrPerson>;

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
export async function startHrStack(options: StackOptions = {}): Promise<HrStack> {
  const postgres = await startPostgres();
  const opened: DataSource[] = [];
  try {
    return await buildHrStack(postgres, opened, options);
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
  readonly effects?: ApprovedEffects;
}

async function buildHrStack(
  postgres: TestPostgres,
  opened: DataSource[],
  options: StackOptions,
): Promise<HrStack> {
  const approval = options.effects ? createApprovalCommands(options.effects) : undefined;
  const submit = options.effects ? createSubmitRequest(options.effects) : undefined;
  const core = createProductAuthorizationCore();
  const release = createProductRelease(core);
  const passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((name) => [
      name,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  const connections = await provisionProductDatabase(postgres.superuser, passwords, [
    ...productMigrations,
    HrmAuthorization1792108800100,
    HrmEmployee1792108800101,
    HrmTeam1792108800102,
    HrmWorkCalendar1792108800103,
    HrmWorkCalendarMakeup1792108800104,
    HrmEmployeeProfile1792108800105,
    HrmWorkRequest1792108800106,
    HrmRequestApproval1792108800107,
    HrmRequestLeadRejected1792108800108,
    HrmLeave1792108800109,
    HrmAttendance1792108800110,
    HrmRequestCancel1792108800111,
  ]);
  const pools = {} as HrStack['pools'];
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
  await fixtureProvider(migration);
  await new ProductManifestReconciler(runner, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  }).reconcile(release);
  await runner.run('sync', (tx) => ensureHrCompany(tx));
  await runner.run('sync', (tx) => ensureWorkCalendar(tx));
  const authorization = new ProductAuthorization(
    runner,
    new ProductBindingRegistry(core, release.declarations, productBindings),
    {
      validators: {
        'fresh@1': (_params, input) => input.context.freshAuthentication === true,
      },
      obligations: productObligations,
    },
    [],
    [
      ...employeeCommands,
      ...teamCommands,
      ...workCalendarCommands,
      ...(submit ? [submit] : workRequestCommands),
      ...(approval ? [approval.leadDecision, approval.finalDecision] : approvalCommands),
      ...cancelCommands,
      ...leaveCommands,
      ...attendanceCommands,
    ],
    [
      ...employeeQueries,
      ...teamQueries,
      ...workCalendarQueries,
      ...workRequestQueries,
      ...approvalQueries,
      ...cancelQueries,
      ...leaveQueries,
      ...attendanceQueries,
      ...reportQueries,
    ],
  );
  const teams = new TeamService(authorization);
  const employees = new EmployeeService(authorization);

  const { userId: rootId } = await bootstrapActiveRoot(runner, release, pools.identity, rootEmail);

  return {
    postgres,
    pools,
    migration,
    runner,
    authorization,
    employees,
    teams,
    workCalendar: new WorkCalendarService(authorization),
    workRequests: new WorkRequestService(authorization, submit),
    approvals: new RequestApprovalService(authorization, approval),
    cancellations: new RequestCancelService(authorization),
    leave: new LeaveService(authorization),
    attendance: new AttendanceService(authorization),
    reports: new ReportService(authorization),
    finalDecision: approval?.finalDecision ?? finalDecision,
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

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import type { PostgresConnectionSettings } from '../dist/database/postgres-connection.types.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  productMigrations,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import {
  ensureHrCompany,
  ensureWorkCalendar,
} from '../dist/modules/hr/helpers/hr-database.helper.js';
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
import { HrmAttendanceAdjust1792108800112 } from '../dist/modules/attendance/migrations/hrm-attendance-adjust.migration.js';
import { treeDigest } from './postgres-shared.helper.ts';
import { fixtureProvider } from './oidc-fixture.helper.ts';
import type { TestPostgres, TestTemplate } from './setup-postgres.ts';

export const hrMigrations = [
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
  HrmAttendanceAdjust1792108800112,
];

export type ProductPurposes = Record<ProductDatabasePurpose, PostgresConnectionSettings>;

/** The `product_*` logins of the database `pg.superuser` points at (roles exist after provisioning). */
export function productConnections(pg: TestPostgres): ProductPurposes {
  return Object.fromEntries(
    (Object.keys(pg.passwords) as ProductDatabasePurpose[]).map((purpose) => [
      purpose,
      { ...pg.superuser, username: `product_${purpose}`, password: pg.passwords[purpose] },
    ]),
  ) as ProductPurposes;
}

/**
 * Digest of every compiled file plus the fixtures the build uses, so any change to a migration,
 * the manifest/release or the sync code names a new template and the old one is never reused.
 */
let digest: string | undefined;

function sourceDigest(): string {
  digest ??= treeDigest(
    [
      fileURLToPath(new URL('../dist/', import.meta.url)),
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('./oidc-fixture.helper.ts', import.meta.url)),
    ],
    ['.js', '.ts'],
  );
  return digest;
}

/**
 * Every product + HR migration applied, release synced, OIDC fixture provider, company and
 * calendar anchors: everything startHrStack needs before its per-file Root and people.
 */
export const hrTemplate: TestTemplate = {
  get name() {
    return `hr_${sourceDigest().slice(0, 16)}`;
  },
  build: async (pg) => {
    const connections = await provisionProductDatabase(pg.superuser, pg.passwords, hrMigrations);
    const opened: DataSource[] = [];
    try {
      const pools = {} as Record<
        'data' | 'identity' | 'authority' | 'sync' | 'bootstrap',
        DataSource
      >;
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
      const core = createProductAuthorizationCore();
      const release = createProductRelease(core);
      await fixtureProvider(migration);
      await new ProductManifestReconciler(runner, new ProductAuditRepository(), {
        core,
        actor: randomUUID() as IdentityId,
        capabilities: release.declarations.capabilities,
      }).reconcile(release);
      await runner.run('sync', (tx) => ensureHrCompany(tx));
      await runner.run('sync', (tx) => ensureWorkCalendar(tx));
    } finally {
      for (const source of opened) await source.destroy().catch(() => undefined);
    }
  },
};

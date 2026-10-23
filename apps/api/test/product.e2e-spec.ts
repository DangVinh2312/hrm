import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  productMigrations,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';

import { NestFactory } from '@nestjs/core';
import { startPostgres } from './setup-postgres.ts';
import {
  activateAccount,
  bindAccount,
  bootstrapActiveRoot,
  oidcSession,
} from './oidc-fixture.helper.ts';
import { startDiscoveryIssuer } from './oidc-discovery.helper.ts';
import { waitForHttpStartup } from './http-startup.helper.ts';
import { AppModule } from '../dist/app.module.js';
import { loadConfig } from '../dist/config/app.config.js';
import { ProductRuntime } from '../dist/infrastructure/product-runtime.service.js';
import { ProductDocument1792108800002 } from '../dist/document/migrations/product-document.migration.js';
import { HrmAuthorization1792108800100 } from '../dist/modules/permission/migrations/hrm-authorization.migration.js';
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
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../dist/authorization/product.manifest.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();
const productObligations = createProductObligations(audit);

const core = createProductAuthorizationCore();
const productRelease = createProductRelease(core);

async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const address = s.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((r) => s.close(() => r()));
  return address.port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

test('actual API boot, OIDC sessions, scoped read/write, Root bypass with fresh writes and revoke fail closed', async (t) => {
  const pg = await startPostgres();
  // ADR 0027 §1: the API needs a discoverable HTTPS issuer before it listens.
  const idp = await startDiscoveryIssuer();
  const pools: DataSource[] = [];
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child) await stop(child);
    await Promise.all(pools.map((p) => p.destroy()));
    await idp.stop();
    await pg.stop();
  });
  const passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'migration', 'bootstrap', 'outbox'].map((p) => [
      p,
      randomBytes(24).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  // The runtime probes the HR schema; its migration needs the owner roles of provisioning.
  const settings = await provisionProductDatabase(pg.superuser, passwords, [
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
  ]);
  const ds = {} as Record<ProductDatabasePurpose, DataSource>;
  for (const purpose of [
    'data',
    'identity',
    'authority',
    'sync',
    'migration',
    'bootstrap',
  ] as const) {
    ds[purpose] = await new DataSource(productDataSourceOptions(settings[purpose])).initialize();
    pools.push(ds[purpose]);
  }
  const runner = new ProductTransactionRunner(ds);
  await ds.migration.query('INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)', [
    idp.issuer,
  ]);
  const migration = ds.migration.createQueryRunner();
  await new ProductDocument1792108800002().up(migration);
  await migration.release();
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
  }).reconcile(productRelease);
  const user = randomUUID() as IdentityId;
  await ds.migration.query(
    `INSERT INTO app_user(id,email_canonical,state) VALUES($1,'reader@example.test','pending')`,
    [user],
  );
  await bindAccount(ds.identity, user, 'reader-subject', idp.issuer);
  // T5: an employee account that submits requests once Root links it to a profile.
  const staff = randomUUID() as IdentityId;
  await ds.migration.query(
    `INSERT INTO app_user(id,email_canonical,state) VALUES($1,'staff@example.test','pending')`,
    [staff],
  );
  await bindAccount(ds.identity, staff, 'staff-subject', idp.issuer);
  await activateAccount(ds.identity, staff);
  const { userId: root } = await bootstrapActiveRoot(
    runner,
    productRelease,
    ds.identity,
    'root@example.test',
    { issuer: idp.issuer },
  );
  const visible = randomUUID(),
    hidden = randomUUID();
  await ds.migration.query(
    `INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes) VALUES($1,$3,'uuid',$4),($2,$3,'uuid',$5)`,
    [visible, hidden, Buffer.from('document'), Buffer.from(visible), Buffer.from(hidden)],
  );
  await ds.migration.query(
    `INSERT INTO document(id,object_id,owner_id,title,state) VALUES($1,$1,$3,'Visible','draft'),($2,$2,$4,'Hidden','draft')`,
    [visible, hidden, user, root],
  );
  // Runtime authority facts: the code-owned reviewer role (default document.read grant) and a direct update grant.
  await runner.run('admin', async (tx) => {
    await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
      user,
      Buffer.from('reviewer'),
    ]);
    await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
      staff,
      Buffer.from('hr.employee'),
    ]);
    await tx.manager.query(
      `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')`,
      [randomUUID(), Buffer.from('document.update'), user, Buffer.from('ownedDocuments')],
    );
  });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH || '',
    NODE_ENV: 'test',
    APP_ORIGIN: origin,
    OIDC_PROVIDERS_JSON: JSON.stringify([
      {
        issuer: idp.issuer,
        clientId: 'fixture-client',
        redirectUri: `${origin}/api/auth/oidc/callback`,
        version: '1',
        assuranceMappings: [],
      },
    ]),
    // Trust only this run's throwaway CA for the discovery call.
    NODE_EXTRA_CA_CERTS: idp.caFile,
    MFA_ENCRYPTION_KEYS: `fixture:${randomBytes(32).toString('base64')}`,
    MFA_ENCRYPTION_KEY_ID: 'fixture',
    PORT: String(port),
    LOG_LEVEL: 'error',
  };
  for (const purpose of ['data', 'identity', 'authority', 'sync'] as const) {
    const c = settings[purpose];
    env[`PRODUCT_${purpose.toUpperCase()}_DATABASE_URL`] =
      `postgres://${c.username}:${c.password}@${c.host}:${c.port}/${c.database}`;
  }

  const launch = () => {
    const processChild = spawn(
      process.execPath,
      [fileURLToPath(new URL('../dist/main.js', import.meta.url))],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    processChild.stdout.on('data', (b: Buffer) => (output += b.toString()));
    processChild.stderr.on('data', (b: Buffer) => (output += b.toString()));
    return {
      processChild,

      output: () => output,
    };
  };

  let running = launch();
  child = running.processChild;
  const live = await waitForHttpStartup(child, `${origin}/api/health/live`, t.signal);
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${origin}/api/health/ready`)).status, 200);
  const jar = new Map<string, string>();
  let csrf = '';

  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        origin,
        'x-csrf-token': csrf,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(';')[0]!;
      const index = first.indexOf('=');
      jar.set(first.slice(0, index), first.slice(index + 1));
    }
    return response;
  }

  const csrfResponse = await request('/api/auth/csrf');
  csrf = ((await csrfResponse.json()) as { csrfToken: string }).csrfToken;
  assert.equal((await request('/api/hr/me')).status, 401);
  assert.equal((await request('/api/hr/requests')).status, 401);
  // T9: reports need a session first.
  assert.equal((await request('/api/hr/reports/seniority?asOn=2026-12-31')).status, 401);
  assert.equal((await request('/api/hr/reports/seniority/export?asOn=2026-12-31')).status, 401);
  // T6: decisions and queues need a session first.
  assert.equal(
    (
      await request(`/api/hr/requests/${randomUUID()}/decision`, 'POST', {
        expectedVersion: '1',
        decision: 'approve',
      })
    ).status,
    401,
  );
  for (const stage of ['lead', 'decided'])
    assert.equal((await request(`/api/hr/approvals/${stage}`)).status, 401);
  // ADR 0027: the link, unlink, Google step-up and every local route are gone.
  for (const [path, method] of [
    ['/api/auth/oidc/link/pending', 'GET'],
    ['/api/auth/oidc/link/confirm', 'POST'],
    ['/api/auth/oidc/reauthenticate', 'POST'],
    ['/api/auth/login', 'POST'],
    ['/api/auth/activate', 'POST'],
    ['/api/auth/reauthenticate', 'POST'],
    ['/api/auth/recovery/request', 'POST'],
  ] as const)
    assert.equal((await request(path, method)).status, 404, `${method} ${path}`);
  assert.deepEqual(await (await request('/api/auth/options')).json(), { methods: ['oidc'] });
  // The reader as a completed Google activation and login leave it (flows: sign-in specs).
  await activateAccount(ds.identity, user);
  jar.set('authz_session', await oidcSession(ds.identity, user));
  // ADR 0023: own sign-in methods without provider subjects (ADR 0027: nothing removable).
  const own = await request('/api/auth/account');
  assert.equal(own.status, 200);
  const ownBody = (await own.json()) as { identities: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(ownBody).sort(), ['email', 'identities', 'mfa']);
  assert.deepEqual(
    ownBody.identities.map((i) => [i.issuer, Object.keys(i).sort()]),
    [[idp.issuer, ['issuer', 'reference']]],
  );
  assert.equal(JSON.stringify(ownBody).includes('reader-subject'), false);
  // Signed in, the removed routes are still unknown.
  const unlinked = await request('/api/auth/oidc/unlink', 'POST', { reference: randomUUID() });
  assert.equal(unlinked.status, 404);
  assert.deepEqual(await unlinked.json(), { statusCode: 404, code: 'error.notFound' });
  assert.equal((await request('/api/auth/session')).status, 200);
  // T3 bootstrap: an account without HR roles gets no profile and no menu (design §10.2).
  const readerMe = await request('/api/hr/me');
  assert.equal(readerMe.status, 200);
  assert.deepEqual(await readerMe.json(), {
    userId: user,
    employee: null,
    menus: [],
    companyScope: false,
  });
  assert.deepEqual(await (await request('/api/hr/employees')).json(), { items: [], total: '0' });
  // T9: no report role, an empty page, never a status that tells absent from foreign; a bad query is 400.
  assert.deepEqual(await (await request('/api/hr/reports/seniority?asOn=2026-12-31')).json(), {
    kind: 'seniority',
    total: '0',
    rows: [],
  });
  assert.equal((await request('/api/hr/reports/seniority')).status, 400);
  // T9B: a caller without the report role is refused the file (403), never handed an empty one;
  // the export takes no page keys.
  const refusedExport = await request('/api/hr/reports/seniority/export?asOn=2026-12-31');
  assert.equal(refusedExport.status, 403);
  assert.deepEqual(await refusedExport.json(), { statusCode: 403, code: 'error.accessDenied' });
  assert.equal(
    (await request('/api/hr/reports/seniority/export?asOn=2026-12-31&limit=5')).status,
    400,
  );
  assert.equal((await request('/api/hr/reports/birthday?from=2026-01&to=2027-01')).status, 400);
  assert.equal((await request('/api/hr/reports/attendance?from=2026-01&to=2027-01')).status, 400);
  // T4: no HR role, no calendar — the same 404 as an absent record.
  assert.equal((await request('/api/hr/work-calendar?year=2026')).status, 404);
  // T5: no HR role, no own requests; detail is the same 404 as an absent record.
  assert.deepEqual(await (await request('/api/hr/requests')).json(), { items: [], total: '0' });
  assert.equal((await request(`/api/hr/requests/${randomUUID()}`)).status, 404);
  // ADR 0032: the `document` resource has no HTTP route; the generic read/update path of the core
  // is exercised in-process with the session the HTTP login produced (no HTTP-level 400/401 for it).
  const documents = new ProductAuthorization(
    runner,
    audit,
    new ProductBindingRegistry(core, productRelease.declarations, productBindings),
    {
      validators: { 'fresh@1': (_p, input) => input.context.freshAuthentication === true },
      obligations: productObligations,
    },
    [{ resource: 'document', action: 'update', fields: ['title'] }],
  );
  const readerSecret = jar.get('authz_session')!;
  const page = await documents.list(readerSecret, 'document', 'read');
  assert.equal(page.total, '1');
  assert.equal(page.items[0]?.title, 'Visible');
  assert.equal(page.items[0]?.ownerId, undefined);
  // Hidden and absent are indistinguishable.
  assert.equal(await documents.detail(readerSecret, 'document', 'read', randomUUID()), null);
  assert.equal(await documents.detail(readerSecret, 'document', 'read', hidden), null);
  await assert.rejects(documents.detail(readerSecret, 'document', 'read', 'not-a-key'));
  // Other apps' cookies on the same site, even malformed or repeated, do not break the session.
  jar.set('other', 'x; other=y; junk');
  assert.equal((await request('/api/hr/me')).status, 200);
  jar.delete('other');
  assert.equal(
    await documents.update(readerSecret, 'document', 'update', visible, {
      title: "changed'; DROP TABLE document; --",
    }),
    true,
  );
  assert.equal(
    await documents.update(readerSecret, 'document', 'update', hidden, { title: 'no' }),
    false,
  );
  assert.equal(
    (
      await ds.migration.query<{ title: string }[]>('SELECT title FROM document WHERE id=$1', [
        visible,
      ])
    )[0]?.title,
    "changed'; DROP TABLE document; --",
  );
  const noCsrf = await fetch(origin + '/api/auth/logout', {
    method: 'POST',
    headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin },
  });
  assert.equal(noCsrf.status, 403);
  // Ending every session of the account fails closed at once.
  assert.equal((await request('/api/auth/logout-all', 'POST')).status, 200);
  assert.equal((await request('/api/hr/me')).status, 401);
  await assert.rejects(documents.list(readerSecret, 'document', 'read'));
  const rootSecret = await oidcSession(ds.identity, root);
  jar.set('authz_session', rootSecret);
  const rootPage = await documents.list(rootSecret, 'document', 'read');
  // Root is outside IAM: every document, still through the projection. Fresh reauthentication only
  // where the action's policy has fresh@1 (ADR 0022): document.update no, account.suspend yes.
  assert.equal(rootPage.total, '2');
  assert.ok(rootPage.items.every((item) => !('ownerId' in item)));
  assert.ok(await documents.detail(rootSecret, 'document', 'read', hidden));
  assert.equal(
    await documents.update(rootSecret, 'document', 'update', hidden, { title: 'Root stale edit' }),
    true,
  );
  assert.equal((await request(`/api/administration/users/${user}/suspend`, 'POST')).status, 403);
  // A step-up 5 s ago, as a 2FA verify leaves it (the flow itself: product-mfa specs).
  const freshRootSecret = await oidcSession(ds.identity, root, { fresh: true });
  jar.set('authz_session', freshRootSecret);
  // Root itself and an absent id look the same: 404 (the account resource holds IAM accounts only).
  assert.equal((await request(`/api/administration/users/${root}/suspend`, 'POST')).status, 404);
  assert.equal(
    (await request(`/api/administration/users/${randomUUID()}/suspend`, 'POST')).status,
    404,
  );
  assert.equal(
    await documents.update(freshRootSecret, 'document', 'update', hidden, { title: 'Root edit' }),
    true,
  );
  // T3 routes through the real module wiring: create, read, assign, validation and CSRF.
  const team = await request('/api/hr/teams', 'POST', { name: 'Team E2E' });
  assert.equal(team.status, 201);
  const { id: teamId } = (await team.json()) as { id: string };
  const employeeBody = {
    code: 'E2E-1',
    fullName: 'Nhân viên E2E',
    hiredOn: '2026-01-05',
    status: 'probation',
    identity: {
      dateOfBirth: null,
      documentKind: null,
      documentNumber: null,
      taxCode: null,
      gender: 'female',
      phone: '+84 90 123 4567',
      workEmail: 'E2E@Example.com',
    },
    position: 'Kỹ sư E2E',
    classification: 'contractor',
  };
  assert.equal(
    (await request('/api/hr/employees', 'POST', { ...employeeBody, role: 'x' })).status,
    400,
  );
  // Probation has no leave rate (ADR 0039): the field is refused, whatever its value.
  assert.equal(
    (await request('/api/hr/employees', 'POST', { ...employeeBody, annualLeaveMinutes: 5760 }))
      .status,
    400,
  );
  // Closed sets and formats are refused before any write.
  for (const identity of [
    { ...employeeBody.identity, gender: 'Nam' },
    { ...employeeBody.identity, phone: '12345' },
    { ...employeeBody.identity, workEmail: 'not-an-email' },
  ])
    assert.equal(
      (await request('/api/hr/employees', 'POST', { ...employeeBody, identity })).status,
      400,
    );
  assert.equal(
    (await request('/api/hr/employees', 'POST', { ...employeeBody, classification: 'intern' }))
      .status,
    400,
  );
  const created = await request('/api/hr/employees', 'POST', employeeBody);
  assert.equal(created.status, 201);
  const { id: employeeId } = (await created.json()) as { id: string };
  assert.equal((await request('/api/hr/employees', 'POST', employeeBody)).status, 409);
  // attendance.adjust through the real wiring: closed body, mandatory key and reason, one
  // answer for a replay, 422 for a reused key, 404 for an absent employee, read needs a month.
  const adjusting = `/api/hr/employees/${employeeId}/attendance-adjustments`;
  const adjustment = {
    workDate: '2026-03-10',
    minutes: -60,
    reason: 'Quên chấm công E2E',
    reference: 'QĐ-E2E/1',
  };
  const adjustKey = randomUUID();
  const withKey = { 'idempotency-key': adjustKey };
  assert.equal((await request(adjusting, 'POST', adjustment)).status, 400, 'no key');
  assert.equal(
    (await request(adjusting, 'POST', { ...adjustment, actor: 'x' }, withKey)).status,
    400,
  );
  assert.equal(
    (await request(adjusting, 'POST', { ...adjustment, reason: ' ' }, withKey)).status,
    400,
  );
  assert.equal(
    (await request(adjusting, 'POST', { ...adjustment, minutes: 0 }, withKey)).status,
    400,
  );
  const adjusted = await request(adjusting, 'POST', adjustment, withKey);
  assert.equal(adjusted.status, 201);
  const { id: adjustmentId } = (await adjusted.json()) as { id: string };
  const replayed = await request(adjusting, 'POST', adjustment, withKey);
  assert.deepEqual([replayed.status, await replayed.json()], [201, { id: adjustmentId }]);
  const keyReuse = await request(adjusting, 'POST', { ...adjustment, minutes: -30 }, withKey);
  assert.deepEqual(
    [keyReuse.status, await keyReuse.json()],
    [422, { statusCode: 422, code: 'error.idempotencyKeyReused' }],
  );
  assert.equal(
    (
      await request(
        `/api/hr/employees/${randomUUID()}/attendance-adjustments`,
        'POST',
        adjustment,
        { 'idempotency-key': randomUUID() },
      )
    ).status,
    404,
  );
  const adjustments = await request(`${adjusting}?month=2026-03`);
  assert.equal(adjustments.status, 200);
  const listed = (await adjustments.json()) as {
    adjustmentMinutes: number;
    total: string;
    items: { id: string; minutes: number; reason: string }[];
  };
  assert.deepEqual(
    [listed.adjustmentMinutes, listed.total, listed.items.map((i) => [i.id, i.minutes, i.reason])],
    [-60, '1', [[adjustmentId, -60, 'Quên chấm công E2E']]],
  );
  assert.equal((await request(adjusting)).status, 400, 'a month is required');
  assert.equal((await request(`${adjusting}?month=2026-03&extra=1`)).status, 400);
  const sheet = (await (
    await request(`/api/hr/employees/${employeeId}/attendance?month=2026-03`)
  ).json()) as {
    adjustmentMinutes: number;
    paidMinutes: number;
  };
  assert.deepEqual([sheet.adjustmentMinutes, sheet.paidMinutes], [-60, 22 * 480 - 60]);
  // T9: Root reads the company: this employee, 11 months 27 days service at the cutoff, no F2 field.
  const seniority = await request('/api/hr/reports/seniority?asOn=2026-12-31');
  assert.equal(seniority.status, 200);
  assert.deepEqual(await seniority.json(), {
    kind: 'seniority',
    total: '1',
    rows: [
      {
        employeeId,
        employeeCode: 'E2E-1',
        employeeName: 'Nhân viên E2E',
        hiredOn: '2026-01-05',
        asOn: '2026-12-31',
        years: 0,
        months: 11,
        days: 27,
        totalDays: 361,
      },
    ],
  });
  // T9B: the same report as an XLSX attachment with a fixed name, readable by an independent reader.
  const file = await request('/api/hr/reports/seniority/export?asOn=2026-12-31');
  assert.equal(file.status, 200);
  assert.equal(
    file.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.equal(
    file.headers.get('content-disposition'),
    'attachment; filename="hrm-report-seniority-2026-12-31.xlsx"',
  );
  assert.equal(file.headers.get('cache-control'), 'no-store');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const exported = workbook.worksheets[0]!;
  assert.equal(exported.rowCount, 2);
  assert.equal(exported.getRow(2).getCell(1).value, 'E2E-1');
  assert.equal(exported.getRow(2).getCell(8).value, 361);
  const detail = (await (await request(`/api/hr/employees/${employeeId}`)).json()) as {
    code: string;
    state: string;
  };
  assert.deepEqual([detail.code, detail.state], ['E2E-1', 'probation']);
  const identity = (await (await request(`/api/hr/employees/${employeeId}/identity`)).json()) as {
    gender: string;
    phone: string;
    workEmail: string;
  };
  assert.deepEqual(
    [identity.gender, identity.phone, identity.workEmail],
    ['female', '0901234567', 'e2e@example.com'],
  );
  assert.equal((await request('/api/hr/employees/not-a-key')).status, 400);
  assert.equal((await request(`/api/hr/employees/${randomUUID()}`)).status, 404);
  assert.equal(
    (await request(`/api/hr/teams/${teamId}/members`, 'POST', { employeeId, primary: true }))
      .status,
    200,
  );
  const members = (await (await request(`/api/hr/teams/${teamId}`)).json()) as {
    members: { employeeId: string; primary: boolean }[];
  };
  assert.deepEqual(
    members.members.map((m) => [m.employeeId, m.primary]),
    [[employeeId, true]],
  );
  const noCsrfDelete = await fetch(`${origin}/api/hr/teams/${teamId}/members/${employeeId}`, {
    method: 'DELETE',
    headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin },
  });
  assert.equal(noCsrfDelete.status, 403);

  // T4 work calendar through the real wiring: validation, CSRF, a versioned change, conflicts.
  const calendar = async () =>
    (await (await request('/api/hr/work-calendar?year=2026')).json()) as {
      version: string;
      holidays: { date: string; name: string }[];
      makeupDays: string[];
    };

  const initial = await calendar();
  assert.deepEqual(initial, { version: '1', year: 2026, holidays: [], makeupDays: [] });
  assert.equal((await request('/api/hr/work-calendar?year=26')).status, 400);
  assert.equal((await request('/api/hr/work-calendar')).status, 400);
  const holiday = { expectedVersion: '1', holiday: 'Ngày lễ E2E' };
  assert.equal(
    (await request('/api/hr/work-calendar/days/2026-11-07', 'PUT', holiday)).status,
    400,
  );
  assert.equal(
    (await request('/api/hr/work-calendar/days/2026-02-30', 'PUT', holiday)).status,
    400,
  );
  const noCsrfPut = await fetch(`${origin}/api/hr/work-calendar/days/2026-11-02`, {
    method: 'PUT',
    headers: {
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify(holiday),
  });
  assert.equal(noCsrfPut.status, 403);
  const changed = await request('/api/hr/work-calendar/days/2026-11-02', 'PUT', holiday);
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { version: '2' });
  const stale = await request('/api/hr/work-calendar/days/2026-11-03', 'PUT', holiday);
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { statusCode: 409, code: 'error.conflict' });
  assert.deepEqual((await calendar()).holidays, [{ date: '2026-11-02', name: 'Ngày lễ E2E' }]);
  // Saturday 2026-11-07 becomes a makeup workday; makeup on a weekday is invalid input.
  assert.equal(
    (
      await request('/api/hr/work-calendar/days/2026-11-09', 'PUT', {
        expectedVersion: '2',
        makeup: true,
      })
    ).status,
    400,
  );
  const makeup = await request('/api/hr/work-calendar/days/2026-11-07', 'PUT', {
    expectedVersion: '2',
    makeup: true,
  });
  assert.equal(makeup.status, 200);
  assert.deepEqual(await makeup.json(), { version: '3' });
  assert.deepEqual((await calendar()).makeupDays, ['2026-11-07']);
  assert.deepEqual(await (await request('/api/hr/me')).json(), {
    userId: root,
    employee: null,
    // T6 part C: Root holds the final step, so the approvals menu shows with nothing waiting.
    menus: ['approvals', 'employees', 'teams', 'calendar', 'reports'],
    companyScope: true,
  });
  // T5 requests through the real wiring. Root has no profile, so nothing to submit for.
  const [{ day } = { day: '' }] = await ds.migration.query<{ day: string }[]>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day
       FROM generate_series((statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 1,
                            (statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 30, interval '1 day') d
      WHERE extract(isodow FROM d) < 6 AND d::date <> DATE '2026-11-02' ORDER BY d LIMIT 1`,
  );
  // A Saturday inside the D06 window of today's business date, made a makeup day by Root (fresh).
  const [{ saturday } = { saturday: '' }] = await ds.migration.query<{ saturday: string }[]>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS saturday
       FROM generate_series((statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 1,
                            (statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 30, interval '1 day') d
      WHERE extract(isodow FROM d) = 6 ORDER BY d LIMIT 1`,
  );

  const saturdayYear = async () =>
    (await (await request(`/api/hr/work-calendar?year=${saturday.slice(0, 4)}`)).json()) as {
      version: string;
      makeupDays: string[];
    };

  const saturdayCalendar = await saturdayYear();
  if (!saturdayCalendar.makeupDays.includes(saturday))
    assert.equal(
      (
        await request(`/api/hr/work-calendar/days/${saturday}`, 'PUT', {
          expectedVersion: saturdayCalendar.version,
          makeup: true,
        })
      ).status,
      200,
    );
  assert.ok((await saturdayYear()).makeupDays.includes(saturday));
  const lateBody = { kind: 'late-arrival', date: day, expectedMinute: 600, reason: 'Kẹt xe E2E' };
  const idempotency = { 'idempotency-key': randomUUID() };
  assert.equal((await request('/api/hr/requests', 'POST', lateBody, idempotency)).status, 404);
  const { version: employeeVersion } = (await (
    await request(`/api/hr/employees/${employeeId}`)
  ).json()) as { version: string };
  assert.equal(
    (
      await request(`/api/hr/employees/${employeeId}/account`, 'PUT', {
        expectedVersion: employeeVersion,
        accountId: staff,
      })
    ).status,
    200,
  );
  jar.set('authz_session', await oidcSession(ds.identity, staff));
  // Validation before any write: key required (UUID v4), owner/state never in the body.
  assert.equal((await request('/api/hr/requests', 'POST', lateBody)).status, 400);
  assert.equal(
    (await request('/api/hr/requests', 'POST', lateBody, { 'idempotency-key': 'x' })).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/api/hr/requests',
        'POST',
        { ...lateBody, employeeId: randomUUID(), state: 'approved' },
        idempotency,
      )
    ).status,
    400,
  );
  const noCsrfSubmit = await fetch(`${origin}/api/hr/requests`, {
    method: 'POST',
    headers: {
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      origin,
      'content-type': 'application/json',
      ...idempotency,
    },
    body: JSON.stringify(lateBody),
  });
  assert.equal(noCsrfSubmit.status, 403);
  const submitted = await request('/api/hr/requests', 'POST', lateBody, idempotency);
  assert.equal(submitted.status, 201);
  const result = (await submitted.json()) as { id: string; state: string; version: string };
  assert.deepEqual([result.state, result.version], ['pending_lead', '1']);
  const replay = await request('/api/hr/requests', 'POST', lateBody, idempotency);
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), result);
  const reused = await request(
    '/api/hr/requests',
    'POST',
    { ...lateBody, expectedMinute: 601 },
    idempotency,
  );
  assert.deepEqual(
    [reused.status, await reused.json()],
    [422, { statusCode: 422, code: 'error.idempotencyKeyReused' }],
  );
  // The same late arrival under a new key overlaps the caller's own pending one: its own key,
  // nothing about which request.
  const overlap = await request('/api/hr/requests', 'POST', lateBody, {
    'idempotency-key': randomUUID(),
  });
  assert.deepEqual(
    [overlap.status, await overlap.json()],
    [409, { statusCode: 409, code: 'error.overlappingRequest' }],
  );
  // A team id the caller is not a current member of (here one that exists nowhere) is one key.
  const foreignTeam = await request(
    '/api/hr/requests',
    'POST',
    { ...lateBody, teamId: randomUUID() },
    { 'idempotency-key': randomUUID() },
  );
  assert.deepEqual(
    [foreignTeam.status, await foreignTeam.json()],
    [422, { statusCode: 422, code: 'error.teamNotMember' }],
  );
  // Leave on the makeup Saturday is a 422 with its own key. The same date takes a late arrival
  // (201), so the 422 comes from the makeup-day leave rule, not the date or employment.
  const makeupLeave = await request(
    '/api/hr/requests',
    'POST',
    {
      kind: 'unpaid-leave',
      segments: [{ date: saturday, startMinute: 540, endMinute: 660 }],
      reason: 'Nghỉ E2E',
    },
    { 'idempotency-key': randomUUID() },
  );
  assert.deepEqual(
    [makeupLeave.status, await makeupLeave.json()],
    [422, { statusCode: 422, code: 'error.makeupDay' }],
  );
  const makeupLate = await request(
    '/api/hr/requests',
    'POST',
    { ...lateBody, date: saturday },
    { 'idempotency-key': randomUUID() },
  );
  assert.equal(makeupLate.status, 201);
  const { id: makeupLateId } = (await makeupLate.json()) as { id: string };
  const mine = (await (await request('/api/hr/requests?limit=10')).json()) as {
    items: { id: string }[];
    total: string;
  };
  assert.deepEqual(
    [mine.total, mine.items.map((item) => item.id).sort()],
    ['2', [result.id, makeupLateId].sort()],
  );
  assert.equal((await request('/api/hr/requests?limit=101')).status, 400);
  const requestDetail = (await (await request(`/api/hr/requests/${result.id}`)).json()) as {
    segments: unknown[];
    reason: string;
  };
  assert.deepEqual(
    [requestDetail.reason, requestDetail.segments],
    ['Kẹt xe E2E', [{ date: day, startMinute: 540, endMinute: 600, minutes: 60 }]],
  );
  assert.equal((await request('/api/hr/requests/not-a-key')).status, 400);
  // T6 through the real wiring: the stage comes from the stored state, never from the body; the
  // staff account leads no team, so its own request (and an absent one) is not found, and both
  // queues and the decided history are empty.

  const decision = (
    id: string,
    body: unknown,
    headers: Record<string, string> = { 'idempotency-key': randomUUID() },
  ) => request(`/api/hr/requests/${id}/decision`, 'POST', body, headers);

  const approve = { expectedVersion: '1', decision: 'approve' };
  assert.equal((await decision(result.id, approve, {})).status, 400);
  assert.equal((await decision(result.id, { ...approve, stage: 'final' })).status, 400);
  assert.equal(
    (await decision(result.id, { expectedVersion: '1', decision: 'reject' })).status,
    400,
  );
  const noCsrfDecision = await fetch(`${origin}/api/hr/requests/${result.id}/decision`, {
    method: 'POST',
    headers: {
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      origin,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify(approve),
  });
  assert.equal(noCsrfDecision.status, 403);
  for (const id of [result.id, randomUUID()]) {
    const missing = await decision(id, approve);
    assert.deepEqual(
      [missing.status, await missing.json()],
      [404, { statusCode: 404, code: 'error.notFound' }],
    );
  }
  for (const stage of ['lead', 'final', 'decided'])
    assert.deepEqual(await (await request(`/api/hr/approvals/${stage}`)).json(), {
      items: [],
      total: '0',
    });
  for (const stage of ['lead', 'decided'])
    assert.equal((await request(`/api/hr/approvals/${stage}?limit=101`)).status, 400);
  jar.set('authz_session', await oidcSession(ds.identity, root, { fresh: true }));
  // Root passes authorization but is never the current first-step approver (403, nothing written).
  const rootDecision = await decision(result.id, approve);
  assert.deepEqual(
    [rootDecision.status, await rootDecision.json()],
    [403, { statusCode: 403, code: 'error.accessDenied' }],
  );
  assert.equal(
    ((await (await request(`/api/hr/requests/${result.id}`)).json()) as { state: string }).state,
    'pending_lead',
  );
  assert.equal((await request(`/api/administration/users/${user}/suspend`, 'POST')).status, 200);
  assert.equal(
    (
      await ds.migration.query<{ state: string }[]>('SELECT state FROM app_user WHERE id=$1', [
        user,
      ])
    )[0]?.state,
    'suspended',
  );
  assert.equal((await request('/api/auth/logout', 'POST')).status, 200);
  assert.equal((await request('/api/auth/session')).status, 401);
  assert.equal((await request('/api/openapi.json')).status, 200);
  await stop(child);
  child = undefined;
  // Simulate unauthorized drift offline. The actual AppModule must fail before opening its listener.
  await ds.migration.query('ALTER TABLE role_definition DISABLE TRIGGER protect_product_rows');
  await ds.migration.query(`UPDATE role_definition SET label='drift' WHERE role_key=$1`, [
    Buffer.from('reviewer'),
  ]);
  await ds.migration.query('ALTER TABLE role_definition ENABLE TRIGGER protect_product_rows');
  running = launch();
  child = running.processChild;
  await new Promise<void>((r) => running.processChild.once('exit', () => r()));
  assert.notEqual(child.exitCode, 0);
  assert.match(running.output(), /Application startup failed/);
  await assert.rejects(fetch(`${origin}/api/health/live`));
  await ds.migration.query('ALTER TABLE role_definition DISABLE TRIGGER protect_product_rows');
  await ds.migration.query("UPDATE role_definition SET label='Reviewer' WHERE role_key=$1", [
    Buffer.from('reviewer'),
  ]);
  await ds.migration.query('ALTER TABLE role_definition ENABLE TRIGGER protect_product_rows');
  await ds.migration.query('REVOKE UPDATE(title) ON document FROM product_data');
  running = launch();
  child = running.processChild;
  await new Promise<void>((r) => running.processChild.once('exit', () => r()));
  assert.notEqual(child.exitCode, 0);
  await assert.rejects(fetch(`${origin}/api/health/live`));
  child = undefined;

  // The same failure in-process, with main.ts's sequence: readiness stays closed, no listener,
  // and the (repeatable) cleanup returns every connection the runtime opened.
  const sessions = async () =>
    new Set(
      (
        await ds.migration.query<{ pid: number }[]>(
          "SELECT pid FROM pg_stat_activity WHERE usename IN ('product_data','product_identity','product_authority','product_sync')",
        )
      ).map((r) => r.pid),
    );

  const before = await sessions();
  const runtime = await idp.trusted(() => ProductRuntime.create(loadConfig(env)));
  assert.ok([...(await sessions())].filter((pid) => !before.has(pid)).length >= 4);
  const app = await NestFactory.create(AppModule.register(runtime), {
    logger: false,
    abortOnError: false,
  });
  await assert.rejects(app.listen(port));
  assert.equal(runtime.readiness.ready, false);
  await assert.rejects(fetch(`${origin}/api/health/live`));
  await runtime.onApplicationShutdown();
  await runtime.onApplicationShutdown();
  let leaked: number[] = [];
  for (let i = 0; i < 50; i++) {
    const current = await sessions();
    leaked = [...current].filter((pid) => !before.has(pid));
    if (!leaked.length) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual(leaked, []);
});

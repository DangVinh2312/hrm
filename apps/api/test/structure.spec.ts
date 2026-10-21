// HTTP surface and DI boundary of the real AppModule, booted in-process with fixture pools.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  RequestMethod,
  type DynamicModule,
  type INestApplication,
} from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, NestFactory } from '@nestjs/core';
import { ProductIdentityService } from '../dist/auth/services/product-identity.service.js';
import { ProductOidcService } from '../dist/auth/services/product-oidc.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { AppModule } from '../dist/app.module.js';
import { loadConfig } from '../dist/config/app.config.js';
import { ProductRuntime } from '../dist/infrastructure/product-runtime.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../dist/authorization/product.manifest.js';

const purposes = ['data', 'identity', 'authority', 'sync'] as const;
const config = loadConfig({
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://127.0.0.1:3000',
  OIDC_PROVIDERS_JSON: JSON.stringify([
    {
      issuer: 'https://idp.example.test',
      clientId: 'fixture-client',
      redirectUri: 'http://127.0.0.1:3000/api/auth/oidc/callback',
      version: '1',
      assuranceMappings: [],
    },
  ]),
  MFA_ENCRYPTION_KEYS: 'fixture:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  MFA_ENCRYPTION_KEY_ID: 'fixture',
  ...Object.fromEntries(
    purposes.map((p) => [
      `PRODUCT_${p.toUpperCase()}_DATABASE_URL`,
      `postgres://product_${p}:fixture-secret@127.0.0.1:1/product`,
    ]),
  ),
});

/** A real ProductRuntime over pools that model TypeORM: no database, destroy() of a closed pool throws. */
function fixtureRuntime(options: { bootstrap?: 'real' } = {}) {
  const log: string[] = [];
  const pools = Object.fromEntries(
    purposes.map((p) => [
      p,
      {
        isInitialized: true,

        destroy(this: { isInitialized: boolean }) {
          if (!this.isInitialized) return Promise.reject(new Error('Pool already closed'));
          this.isInitialized = false;
          return Promise.resolve();
        },

        query: () => (log.push(`${p}.query`), Promise.reject(new Error('No database'))),

        // Transactions (manifest sync, provider rows) go through query runners.
        createQueryRunner: () => {
          log.push(`${p}.createQueryRunner`);
          throw new Error('No database');
        },
      },
    ]),
  ) as unknown as Record<(typeof purposes)[number], { isInitialized: boolean }>;
  const runner = new ProductTransactionRunner(pools as never);
  const identity = new ProductIdentityService(runner);
  // ProductRuntime.create composes exactly this after opening the pools.
  const Runtime = ProductRuntime as unknown as new (...args: unknown[]) => ProductRuntime;
  const runtime = new Runtime(
    config,
    createProductAuthorizationCore(),
    pools,
    runner,
    identity,
    new ProductOidcService(identity, new Map()),
  );
  if (options.bootstrap !== 'real')
    Object.assign(runtime, {
      onApplicationBootstrap: () => Promise.resolve(runtime.readiness.markReady()),
    });
  return { runtime, pools, log };
}

const create = (module: DynamicModule) =>
  NestFactory.create(module, { logger: false, abortOnError: false });

function routeInventory(app: INestApplication): string[] {
  return app
    .get(DiscoveryService, { strict: false })
    .getControllers()
    .flatMap(({ metatype }) => {
      const prefix = Reflect.getMetadata(PATH_METADATA, metatype!) as string;
      const prototype = (metatype as { prototype: Record<string, unknown> }).prototype;
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
        const classes = (key ? Reflect.getOwnMetadata(key, handler) : []) as {
          kind: string;
          resource?: string;
          action?: string;
        }[];
        const classification = classes
          .map((c) => (c.kind === 'authorize' ? `${c.resource}.${c.action}` : c.kind))
          .join(',');
        return [`${RequestMethod[method]} /${path} ${status} ${classification}`];
      });
    })
    .sort();
}

/** Every key (own and prototype) reachable from what the controllers were injected with. */
function exposure(app: INestApplication) {
  const keys = new Set<string>();
  const operations = new Set<string>();
  const urls: string[] = [];
  const seen = new Set<object>();

  const walk = (value: unknown, depth: number) => {
    if (typeof value === 'string' && /postgres(ql)?:/i.test(value)) urls.push(value);
    if (value instanceof URL) return void urls.push(value.href);
    if (value === null || typeof value !== 'object' || seen.has(value) || depth > 5) return;
    seen.add(value);
    for (
      let o: object | null = value;
      o && o !== Object.prototype;
      o = Object.getPrototypeOf(o) as object | null
    )
      for (const key of Reflect.ownKeys(o)) {
        if (key === 'constructor') continue;
        keys.add(String(key));
        const descriptor = Object.getOwnPropertyDescriptor(o, key)!;
        if (typeof descriptor.value === 'function') operations.add(String(key));
        else if ('value' in descriptor) walk(descriptor.value, depth + 1);
      }
  };

  for (const { instance } of app.get(DiscoveryService, { strict: false }).getControllers())
    for (const injected of Object.values(instance as object)) walk(injected, 0);
  return { keys, operations: [...operations].sort(), urls };
}

// ADR 0020: email accounts (provision/read), own sign-in methods and public enabled methods.
// ADR 0023 link proof routes, unlink and the OIDC step-up removed again by ADR 0027 §6–7.
// T3: HR bootstrap, employee profile (F1/F2/F3, account link) and team/membership/lead routes.
// T4: work calendar read (every HR role) and change of one weekday (HR/Admin, fresh).
// T5: submit a request on the own profile, own request list and request detail.
// T6: decide a request at its stored stage (session-classified: the permission follows the state)
// and the lead/final queues.
// ADR 0026: the session's own TOTP second factor (setup, confirm, verify, recovery codes, remove).
const expectedRoutes = [
  'DELETE /api/auth/mfa/totp 200 authenticated',
  'DELETE /api/hr/teams/:id/members/:employeeId 200 team.assign',
  'GET /api/administration/accounts 200 account.read',
  'GET /api/auth/account 200 authenticated',
  'GET /api/auth/csrf 200 public',
  'GET /api/auth/oidc/callback 303 public',
  'GET /api/auth/options 200 public',
  'GET /api/auth/session 200 authenticated',
  'GET /api/documents 200 document.read',
  'GET /api/documents/:id 200 document.read',
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
  'GET /api/hr/employees/:id/identity 200 employeeIdentity.read',
  'GET /api/hr/employees/:id/leave-balance 200 employee.readLeaveBalance',
  'GET /api/hr/employees/:id/leave-rates 200 leaveRate.read',
  'GET /api/hr/leave/reconciliation 200 employee.readLeaveBalance',
  'GET /api/hr/me 200 authenticated',
  'GET /api/hr/requests 200 workRequest.read',
  'GET /api/hr/requests/:id 200 workRequest.read',
  'GET /api/hr/teams 200 team.read',
  'GET /api/hr/teams/:id 200 team.read',
  'GET /api/hr/work-calendar 200 workCalendar.read',
  'GET /api/openapi.json 200 public',
  'PATCH /api/documents/:id 200 document.update',
  'PATCH /api/hr/employees/:id 200 employee.update',
  'PATCH /api/hr/teams/:id 200 team.update',
  'POST /api/administration/accounts 201 account.provision',
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
  'POST /api/hr/employees/:id/leave-adjustments 201 employee.adjustLeaveBalance',
  'POST /api/hr/employees/:id/leave-rates 201 employee.adjustLeaveRate',
  'POST /api/hr/employees/:id/official 200 employee.update',
  'POST /api/hr/employees/:id/termination 200 employee.update',
  'POST /api/hr/requests 201 employee.submitRequest',
  'POST /api/hr/requests/:id/cancel 200 authenticated',
  'POST /api/hr/requests/:id/decision 200 authenticated',
  'POST /api/hr/teams 201 hrCompany.createTeam',
  'POST /api/hr/teams/:id/members 200 team.assign',
  'POST /api/hr/teams/:id/members/:employeeId/primary 200 team.assign',
  'PUT /api/hr/employees/:id/account 200 employee.linkAccount',
  'PUT /api/hr/employees/:id/identity 200 employeeIdentity.update',
  'PUT /api/hr/teams/:id/lead 200 team.assign',
  'PUT /api/hr/work-calendar/days/:date 200 workCalendar.manage',
];
const expectedOperations = [
  'addMember',
  'adjust',
  'adjustLeaveRate',
  'assignLead',
  'balance',
  'begin',
  'callback',
  'cancel',
  'closePeriod',
  'confirm',
  'confirmOfficial',
  'create',
  'currentSession',
  'decide',
  'decided',
  'detail',
  'endMembership',
  'finalQueue',
  'identity',
  'leadQueue',
  'leaveRates',
  'linkAccount',
  'list',
  'listAccounts',
  'logout',
  'markReady',
  'me',
  'menus',
  'ownAccount',
  'period',
  'periodState',
  'provisionAccount',
  'reconciliation',
  'regenerateRecoveryCodes',
  'remove',
  'rename',
  'reopenPeriod',
  'setDay',
  'setPrimary',
  'setup',
  'snapshot',
  'status',
  'submit',
  'suspendUser',
  'terminate',
  'update',
  'updateIdentity',
  'verify',
  'year',
];
// Changed deliberately (ADR 0019): every path moved under /api and the OIDC callback documents a
// fixed 303 redirect instead of a JSON body. Changed again: error responses document the
// `{ statusCode, code }` body whose `code` is a web locale key (api-error.helper.ts). Changed
// again (ADR 0020): account provisioning/list, own account, sign-in options, session menus.
// Changed again (T3): HR bootstrap, employee and team routes (hr-openapi.schema.ts).
// Changed again (ADR 0023): account identities by reference + removable, unlink by reference,
// link proof pending/cancel/confirm routes and the two link callback targets.
// ADR 0023 §3.3 (migration 015 round): link=failed also covers a cancel at the provider.
// Changed again (ADR 0026): /api/auth/mfa/* routes, `mfa` in the own account, reauthenticate note.
// Changed again (ADR 0027 step 2): link, link proof, unlink and OIDC reauthenticate routes gone,
// `removable` gone from the own account, only the login callback targets remain.
// Changed again (ADR 0027 step 3): local login, activation, password step-up, password change and
// recovery routes gone; options list oidc only; `password` gone from the own account.
// Changed again (T4): work calendar routes and the `calendar` menu in the HR bootstrap example.
// Changed again (T4 makeup): `makeupDays` in the calendar year, `makeup` body for Saturday/Sunday.
// Changed again (T4 minors): `error.makeupDay` joins the closed error `code` enum.
// Changed again (ADR 0028): F1 `position`/`classification`, F2 `gender`/`phone`/`workEmail` in the employee bodies and examples.
// Changed again (T5): POST/GET /api/hr/requests (Idempotency-Key header, body per kind) and GET /api/hr/requests/{id}.
// Changed again (T5 web): `requests` in the /api/hr/me menus example.
// Changed again (T5 422, user decision 2026-10-20): seven business rejection keys join the closed
// error `code` enum; POST /api/hr/requests documents 422 and names each rule's key in its summary.
// Changed again (T6): POST /api/hr/requests/{id}/decision, GET /api/hr/approvals/{lead,final},
// and `reason` in the decision history example of GET /api/hr/requests/{id}.
// Changed again (T6 web): `approvals` in the /api/hr/me menus example.
// Changed again (T6 part C): GET /api/hr/approvals/decided (decided history, workRequest.readDecided).
// Changed again (release 9): `employeeName` (owner's full name) in the decided history items.
// Changed again (T7, release 10): GET /api/hr/employees/{id}/leave-balance and
// GET /api/hr/leave/reconciliation, `leave` in the /api/hr/me menus example, and the closed error
// `code` enum gains `error.insufficientLeave` (422 on POST /api/hr/requests, annual leave).
// Changed again (T8, release 11): GET /api/hr/employees/{id}/attendance and
// POST /api/hr/attendance/periods/{month}/{close,reopen}, `attendance` in the /api/hr/me menus
// example, `acknowledgeWfhLimit` in the decision body, `wfhLimitExceeded` in the submit result, and
// the error `code` enum gains `error.periodClosed` and `error.wfhLimitAckRequired` (409; submit,
// decision, calendar day).
// Changed again (T8 part B, release 12): POST /api/hr/requests/{id}/cancel,
// POST /api/hr/employees/{id}/leave-adjustments, GET /api/hr/attendance/periods/{month}, and the
// submit description now says a COO's own request is approved at submit (§6.4 (1)). No new error
// code: every status they return already had its closed key. Re-pinned once more after review:
// the `leave-adjustments` response example is a ledger entry id, not a request id.
const openApiSha256 = 'b4a0c67ee276a0a25abc9a716c6aa87e35929b4cef09bc1d260026e16391a221';

test('route inventory, OpenAPI, cookie/CSRF and handler exposure are pinned', async (t) => {
  const { runtime } = fixtureRuntime();
  const app = await create(AppModule.register(runtime));
  t.after(() => app.close());
  assert.deepEqual(routeInventory(app), expectedRoutes);

  const { keys, operations, urls } = exposure(app);
  assert.deepEqual(operations, expectedOperations);
  for (const forbidden of [
    'transactions',
    'manager',
    'pools',
    'runner',
    'databases',
    'release',
    'core',
    'bindings',
    'reconcile',
    'issueActivation',
    'authenticate',
    'onApplicationBootstrap',
    'onApplicationShutdown',
  ])
    assert.ok(!keys.has(forbidden), `handlers can reach ${forbidden}`);
  assert.deepEqual(urls, [config.origin.href], 'only the public origin URL is reachable');

  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const openapi = await fetch(`${base}/api/openapi.json`);
  assert.equal(openapi.status, 200);
  const document = (await openapi.json()) as { paths: Record<string, Record<string, unknown>> };
  assert.equal(createHash('sha256').update(JSON.stringify(document)).digest('hex'), openApiSha256);
  // Every route is documented and every documented operation is a route.
  assert.deepEqual(
    Object.entries(document.paths)
      .flatMap(([path, item]) =>
        Object.keys(item)
          .filter((m) => m !== 'parameters')
          .map((m) => `${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`),
      )
      .sort(),
    expectedRoutes.map((r) => r.split(' ').slice(0, 2).join(' ')).sort(),
  );

  const csrf = await fetch(`${base}/api/auth/csrf`);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(csrf.headers.getSetCookie(), [
    `authz_csrf=${csrfToken}; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly`,
  ]);

  // The public OIDC begin is the CSRF-protected route a signed-out browser reaches (ADR 0027).
  const begin = (headers: Record<string, string>) =>
    fetch(`${base}/api/auth/oidc/begin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ issuer: 'https://idp.example.test' }),
    });

  const cookie = `authz_csrf=${csrfToken}`;
  const attempts: Record<string, string>[] = [
    { cookie, origin: config.origin.origin },
    { cookie, origin: 'http://attacker.test', 'x-csrf-token': csrfToken },
    { origin: config.origin.origin, 'x-csrf-token': csrfToken },
  ];
  for (const headers of attempts) {
    const response = await begin(headers);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { statusCode: 403, code: 'error.accessDenied' });
  }
  assert.equal((await fetch(`${base}/api/health/ready`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/health/metrics`)).json(), []);

  // ADR 0019: a failed OIDC callback returns the browser to a fixed page, never sets a session
  // and never follows a target supplied by the request.
  for (const query of ['', '?state=a&state=b', '?code=y&next=https://attacker.test/']) {
    const callback = await fetch(`${base}/api/auth/oidc/callback${query}`, {
      redirect: 'manual',
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/login?error=oidc');
    assert.deepEqual(callback.headers.getSetCookie(), [
      'authz_browser=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly',
    ]);
  }
  // A non-authentication fault (here: no database behind the fixture) is not turned into a
  // redirect; the error filter answers it like any other route.
  const unavailable = await fetch(`${base}/api/auth/oidc/callback?state=x&code=y`, {
    redirect: 'manual',
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('location'), null);
  // Routes moved under /api (ADR 0019); the old root paths are not aliases.
  for (const path of ['/auth/csrf', '/health/live', '/openapi.json'])
    assert.equal((await fetch(`${base}${path}`)).status, 404);
});

function unclassifiedController() {
  class Unclassified {
    handler() {
      return {};
    }
  }
  Controller('unclassified')(Unclassified);
  Get()(
    Unclassified.prototype,
    'handler',
    Object.getOwnPropertyDescriptor(Unclassified.prototype, 'handler')!,
  );
  return Unclassified;
}

/** Records runtime bootstrap calls instead of touching a database. */
function spiedRuntime() {
  const { runtime } = fixtureRuntime();
  const calls: string[] = [];
  Object.assign(runtime, {
    onApplicationBootstrap: () => {
      calls.push('runtime bootstrap');
      runtime.readiness.markReady();
      return Promise.resolve();
    },
  });
  return { runtime, calls };
}

test('a route without classification fails boot before any runtime bootstrap', async () => {
  // The runtime bootstrap publishes the manifest and opens readiness: it must never start.
  const { runtime, calls } = spiedRuntime();
  const module = AppModule.register(runtime);
  const app = await create({
    ...module,
    controllers: [...(module.controllers ?? []), unclassifiedController()],
  });
  await assert.rejects(app.init(), /exactly one classification/);
  assert.deepEqual(calls, []);
  assert.equal(runtime.readiness.ready, false);
  await app.close();
});

test('a fully classified app runs the runtime bootstrap once and becomes ready', async () => {
  const { runtime, calls } = spiedRuntime();
  const app = await create(AppModule.register(runtime));
  await app.init();
  assert.deepEqual(calls, ['runtime bootstrap']);
  assert.equal(runtime.readiness.ready, true);
  await app.close();
});

test('the composed release and storage bindings are unchanged', () => {
  // The hash is what manifest sync stores; a different hash would be a new release.
  // Release 3 (ADR 0016, T2): HR roles, resources, scopes and their storage bindings.
  // Release 4 (ADR 0020): account.provision/account.read, auditedRead policy, account fields
  // email/enrollment and the account binding moved to the account_directory projection.
  // Release 5 (T3): hrCompany, employeeIdentity, leaveRate and their bindings/owner views,
  // employee/team write actions (linkAccount/assign boundary required), hrWrite/hrFresh.
  // Release 6 (T4): workCalendar (read every HR role, manage HR/Admin fresh) and its binding.
  // Release 7 (ADR 0016 §7): boundary hrAdministration@1 (team.assign, employee.linkAccount).
  // Release 8 (T6 part C): workRequest.readDecided, team/hrCompany.approvals and their grants.
  // Release 9 (T6 part C): workRequest.readLeadRejected (the COO reads a lead's request rejected
  // at the lead step); binding
  // hrRequestLeadRejected (view hr_request_lead_rejected).
  // Release 10 (T7): employee.readLeaveBalance (own, a lead's members, HR) and three grants; no
  // new resource, so the storage bindings below keep their hash.
  // Release 11 (T8): employee.readAttendance (own, HR), hrCompany.managePeriod (HR, fresh) and three
  // grants; again no new resource, so the bindings keep their hash.
  // Release 12 (T8 part B): employee.adjustLeaveBalance (HR, fresh) and one grant; bindings again.
  const release = createProductRelease(createProductAuthorizationCore());
  assert.equal(release.hash, '86cce38109869706f8c8e809f2a6b4e162882d002288a2cdc1eec3599369cfb3');
  assert.equal(
    createHash('sha256').update(JSON.stringify(productBindings)).digest('hex'),
    '513291194a5046dc59eb5db08034ab0da7e86c7e5c372360e8d89a3ba68ca3fd',
  );
});

type ModuleNode = DynamicModule | (abstract new (...args: never[]) => unknown);

const moduleOf = (node: ModuleNode) => ('module' in node ? node.module : node);

const declaresControllers = (node: ModuleNode) =>
  Boolean(
    ('module' in node && node.controllers?.length) ||
    (Reflect.getMetadata('controllers', moduleOf(node)) as unknown[] | undefined)?.length,
  );

/** Same composition with `probe` added to the one module `target`. */
function withProvider(node: ModuleNode, target: unknown, probe: object): ModuleNode {
  const dynamic: DynamicModule = 'module' in node ? node : { module: node as never };
  return {
    ...dynamic,
    imports: dynamic.imports?.map((child) => withProvider(child as ModuleNode, target, probe)),
    providers: [...(dynamic.providers ?? []), ...(dynamic.module === target ? [probe] : [])],
  } as DynamicModule;
}

function controllerModules(node: ModuleNode, found = new Set<unknown>()): Set<unknown> {
  if (declaresControllers(node)) found.add(moduleOf(node));
  for (const child of ('module' in node ? node.imports : undefined) ?? [])
    controllerModules(child as ModuleNode, found);
  return found;
}

test('no module that declares controllers can resolve the raw runtime', async () => {
  class RawRuntimeProbe {
    runtime: unknown;

    constructor(runtime: unknown) {
      this.runtime = runtime;
    }
  }
  Injectable()(RawRuntimeProbe);
  Inject(ProductRuntime)(RawRuntimeProbe, undefined, 0);
  class EmptyProbe {}
  Injectable()(EmptyProbe);
  const root = AppModule.register(fixtureRuntime().runtime);
  const targets = controllerModules(root);
  assert.deepEqual([...targets].map((m) => (m as { name: string }).name).sort(), [
    'AdministrationModule',
    'AppModule',
    'AttendanceModule',
    'AuthModule',
    'DocumentModule',
    'EmployeeModule',
    'HealthModule',
    'HrModule',
    'LeaveModule',
    'TeamModule',
    'WorkCalendarModule',
    'WorkRequestModule',
  ]);
  for (const target of targets) {
    const name = (target as { name: string }).name;
    // Positive control: the same placement resolves a provider without the raw token.
    const control = await create(withProvider(root, target, EmptyProbe) as DynamicModule);
    await control.close();
    let app: INestApplication | undefined;
    await assert.rejects(
      (async () =>
        (app = await create(withProvider(root, target, RawRuntimeProbe) as DynamicModule)))(),
      /can't resolve dependencies of the RawRuntimeProbe/,
      `${name} resolved ProductRuntime`,
    );
    await app?.close();
  }
});

test('a failing bootstrap keeps readiness closed and never opens the listener', async () => {
  // Real onApplicationBootstrap: the privilege probe fails on the fixture pools.
  const { runtime, pools, log } = fixtureRuntime({ bootstrap: 'real' });
  const app = await create(AppModule.register(runtime));
  await assert.rejects(app.listen(0, '127.0.0.1'));
  assert.equal(runtime.readiness.ready, false);
  // Probe first: its failure stops boot before manifest sync opens a transaction.
  assert.deepEqual(log, ['data.query']);
  assert.equal((app.getHttpServer() as { listening: boolean }).listening, false);
  // main.ts cleanup after a failed start, then a later shutdown hook: both must succeed.
  await runtime.onApplicationShutdown();
  await runtime.onApplicationShutdown();
  for (const pool of Object.values(pools)) assert.equal(pool.isInitialized, false);
});

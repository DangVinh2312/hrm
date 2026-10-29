// On PostgreSQL: who reads and updates which settings group, defaults when a
// row is missing, optimistic versions, the append-only history, atomic audit, one winner of two
// concurrent writes, and that a change never rewrites what was already recorded. Synthetic people
// only; H = admin, C = COO, E = employee, N = signed in without HR role.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { securityPolicy } from '../dist/config/security-policy.config.js';
import { SettingKey } from '../dist/modules/setting/setting.registry.js';
import type { SettingListView } from '../dist/modules/setting/setting.types.js';
import { withClient } from './setup-postgres.ts';
import { type ModulePerson, type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

let stack: ModuleStack;
const people: Record<string, ModulePerson> = {};

const p = (name: string) => {
  const person = people[name];
  if (!person) throw new Error(`Unknown fixture person ${name}`);
  return person;
};

const utf8 = (value: string) => Buffer.from(value, 'utf8');

before(async () => {
  stack = await startModuleStack();
  for (const [name, roles] of [
    ['H', ['hr.employee', 'hr.admin']],
    ['C', ['hr.employee', 'hr.coo']],
    ['E', ['hr.employee']],
    ['N', []],
    ['R', []],
    ['P', []],
  ] as const)
    people[name] = await stack.person(roles);
});

after(() => stack?.stop());

const one = async (sql: string, params: unknown[] = []) =>
  (await stack.migration.query<{ v: string | null }[]>(sql, params))[0]?.v ?? null;

const rows = (table: 'system_setting' | 'system_setting_history') =>
  one(`SELECT count(*)::text AS v FROM ${table}`);

const audits = () =>
  one(
    `SELECT count(*)::text AS v FROM audit_outbox WHERE convert_from(event_kind,'UTF8')='setting.update'`,
  );

const find = (view: SettingListView | undefined, key: string) =>
  view?.settings.find((setting) => setting.key === key);

const update = (secret: string, key: string, value: unknown, expectedVersion: string) =>
  stack.settings.update(secret, { key, value, expectedVersion } as never);

const grant = (userId: string, action: string) =>
  stack.migration.query(
    "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
    [randomUUID(), utf8(`setting.${action}`), userId, utf8('setting')],
  );

const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

test('read is HR rules and profile for admin and COO; every HR role reads the profile; no role reads nothing', async () => {
  for (const name of ['H', 'C']) {
    const view = await stack.settings.list(p(name).secret);
    assert.equal(view?.settings.length, 10, name);
  }
  // An employee reads the profile but not the rules; a roleless account reads nothing.
  assert.equal(await stack.settings.list(p('E').secret), undefined);
  assert.equal(await stack.settings.security(p('E').secret), undefined);
  assert.equal(
    await stack.settings.history(p('E').secret, SettingKey.WfhMonthLimit, { limit: 20, offset: 0 }),
    undefined,
  );
  for (const name of ['H', 'C', 'E'])
    assert.deepEqual(await stack.settings.profile(p(name).secret), {
      companyName: '',
      defaultLocale: 'vi',
    });
  assert.equal(await stack.settings.profile(p('N').secret), undefined);
  assert.equal(await stack.settings.list(p('N').secret), undefined);
  // Root reads everything without a grant.
  assert.equal((await stack.settings.list(await stack.root()))?.settings.length, 10);
});

test('a missing row means the code default at version 0, flagged as default', async () => {
  const view = await stack.settings.list(p('H').secret);
  assert.deepEqual(find(view, SettingKey.WfhMonthLimit), {
    key: 'hr.wfhMonthLimit',
    group: 'rule',
    kind: 'int',
    unit: 'days',
    value: 4,
    default: 4,
    min: 0,
    max: 31,
    version: '0',
    isDefault: true,
    updatedAt: null,
  });
  assert.deepEqual(find(view, SettingKey.CompanyDefaultLocale), {
    key: 'company.defaultLocale',
    group: 'profile',
    kind: 'enum',
    values: ['vi', 'en'],
    value: 'vi',
    default: 'vi',
    version: '0',
    isDefault: true,
    updatedAt: null,
  });
  assert.equal(await rows('system_setting'), '0');
});

test('the group of a key decides the permission: updateRule is not updateProfile, read is neither', async () => {
  const before = {
    current: await rows('system_setting'),
    history: await rows('system_setting_history'),
  };
  // COO and employee hold read/readProfile only; N holds nothing.
  for (const name of ['C', 'E', 'N']) {
    await assert.rejects(
      update(p(name).secret, SettingKey.WfhMonthLimit, 5, '0'),
      ProductAccessDenied,
      name,
    );
    await assert.rejects(
      update(p(name).secret, SettingKey.CompanyName, 'X', '0'),
      ProductAccessDenied,
      name,
    );
  }
  assert.deepEqual(
    { current: await rows('system_setting'), history: await rows('system_setting_history') },
    before,
  );
  // A runtime grant of exactly one update action opens exactly one group (no fresh needed).
  await grant(p('R').id, 'updateRule');
  await grant(p('P').id, 'updateProfile');
  await update(p('R').secret, SettingKey.RequestWindowPastDays, 10, '0');
  await assert.rejects(
    update(p('R').secret, SettingKey.CompanyName, 'X', '0'),
    ProductAccessDenied,
  );
  await update(p('P').secret, SettingKey.CompanyName, 'Công ty Giả', '0');
  await assert.rejects(
    update(p('P').secret, SettingKey.RequestWindowPastDays, 3, '1'),
    ProductAccessDenied,
  );
  // Update does not imply read.
  assert.equal(await stack.settings.list(p('R').secret), undefined);
  assert.equal(await stack.settings.profile(p('P').secret), undefined);
  assert.equal((await stack.settings.profile(p('H').secret))?.companyName, 'Công ty Giả');
  // Put the two rows back for the later tests.
  await update(p('R').secret, SettingKey.RequestWindowPastDays, 7, '1');
  await update(p('P').secret, SettingKey.CompanyName, '', '1');
});

test('admin updates with a plain session (no fresh); versions count 1, 2, 3 and the history keeps every step', async () => {
  const h = p('H').secret;
  assert.deepEqual(await update(h, SettingKey.WfhMonthLimit, 6, '0'), { version: '1' });
  assert.deepEqual(await update(h, SettingKey.WfhMonthLimit, 8, '1'), { version: '2' });
  const view = await stack.settings.list(h);
  const row = find(view, SettingKey.WfhMonthLimit);
  assert.equal(row?.value, 8);
  assert.equal(row?.version, '2');
  assert.equal(row?.isDefault, false);
  assert.notEqual(row?.updatedAt, null);
  const history = await stack.settings.history(h, SettingKey.WfhMonthLimit, {
    limit: 20,
    offset: 0,
  });
  assert.equal(history?.total, '2');
  // Newest first; the first step records the effective old value (the default), not null.
  assert.deepEqual(
    history?.items.map((item) => [item.version, item.oldValue, item.newValue]),
    [
      ['2', 6, 8],
      ['1', 4, 6],
    ],
  );
  // A key nobody wrote has an empty history (still readable).
  assert.deepEqual(
    await stack.settings.history(h, SettingKey.ReportMaxMonths, { limit: 20, offset: 0 }),
    {
      items: [],
      total: '0',
    },
  );
  await update(h, SettingKey.WfhMonthLimit, 4, '2');
});

test('a stale version is 409, writing the value already in force is 409, and nothing changes', async () => {
  const h = p('H').secret;
  const before = {
    current: await rows('system_setting'),
    history: await rows('system_setting_history'),
    audits: await audits(),
  };
  await assert.rejects(update(h, SettingKey.ReportMaxMonths, 6, '3'), rejected('stale_version'));
  await assert.rejects(update(h, SettingKey.ReportMaxMonths, 6, '1'), rejected('stale_version'));
  // Version 0 for a key that has no row, the same value as the default: nothing to record.
  await assert.rejects(update(h, SettingKey.ReportMaxMonths, 12, '0'), rejected('unchanged'));
  assert.deepEqual(
    {
      current: await rows('system_setting'),
      history: await rows('system_setting_history'),
      audits: await audits(),
    },
    before,
  );
});

test('the service re-validates: unknown key, wrong type, out of range and wrong group are 400 even if a caller forges them', async () => {
  const h = p('H').secret;
  const before = await rows('system_setting');
  for (const [key, value] of [
    ['hr.nope', 1],
    ['hr.wfhMonthLimit', '5'],
    ['hr.wfhMonthLimit', 32],
    ['hr.wfhMonthLimit', 1.5],
    ['export.maxRows', 5001],
    ['export.maxBytes', 5_242_881],
    ['report.maxMonths', 13],
    ['hr.requestMaxDays', 32],
    ['company.defaultLocale', 'fr'],
    ['company.name', 'x'.repeat(121)],
    ['__proto__', 1],
  ] as const)
    await assert.rejects(
      update(h, key, value, '0'),
      ProductInvalidRequest,
      `${key}=${String(value)}`,
    );
  assert.equal(await rows('system_setting'), before);
});

test('the history is append-only: the runtime cannot UPDATE/DELETE it and a trigger stops even the owner', async () => {
  const denied = (error: unknown) =>
    (error as { driverError?: { code?: string } }).driverError?.code === '42501';

  await assert.rejects(
    stack.pools.data.query(`UPDATE system_setting_history SET new_value = '1'::jsonb`),
    denied,
  );
  await assert.rejects(stack.pools.data.query('DELETE FROM system_setting_history'), denied);
  await assert.rejects(stack.pools.data.query('DELETE FROM system_setting'), denied);
  await assert.rejects(
    stack.pools.data.query(`UPDATE system_setting SET key = key || 'x'`),
    denied,
  );
  for (const sql of [
    `UPDATE system_setting_history SET new_value = '1'::jsonb`,
    'DELETE FROM system_setting_history',
    'TRUNCATE system_setting_history',
  ])
    await assert.rejects(
      stack.migration.query(sql),
      (error: unknown) => /append-only/.test((error as { message?: string }).message ?? ''),
      sql,
    );

  // Shape constraints hold for the owner as well: a malformed key and a non-scalar value.
  const check = (error: unknown) =>
    (error as { driverError?: { code?: string } }).driverError?.code === '23514';

  for (const [key, value] of [
    ['Bad Key', '1'],
    ['nodot', '1'],
    ['hr.x', '{"a":1}'],
    ['hr.x', '[1]'],
    ['hr.x', 'null'],
  ])
    await assert.rejects(
      stack.migration.query(
        `INSERT INTO system_setting(key,value,version,updated_by) VALUES ($1, $2::jsonb, 1, $3)`,
        [key, value, p('H').id],
      ),
      check,
      `${key} ${value}`,
    );
});

test('a failing audit writer rolls back both the current row and the history', async () => {
  const h = p('H').secret;
  const before = {
    current: await rows('system_setting'),
    history: await rows('system_setting_history'),
    audits: await audits(),
  };
  const version =
    find(await stack.settings.list(h), SettingKey.RequestWindowFutureDays)?.version ?? '';
  await withClient(stack.postgres.superuser, (client) =>
    client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(
      update(h, SettingKey.RequestWindowFutureDays, 30, version),
      (error) => !(error instanceof ProductAccessDenied),
    );
  } finally {
    await withClient(stack.postgres.superuser, (client) =>
      client.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.deepEqual(
    {
      current: await rows('system_setting'),
      history: await rows('system_setting_history'),
      audits: await audits(),
    },
    before,
  );
  assert.equal(find(await stack.settings.list(h), SettingKey.RequestWindowFutureDays)?.value, 90);
  // The same update works once the writer is back, and leaves exactly one audit event by target id only.
  await update(h, SettingKey.RequestWindowFutureDays, 30, version);
  assert.equal(await audits(), String(Number(before.audits) + 1));
  const [event] = await stack.migration.query<{ metadata: unknown }[]>(
    `SELECT safe_metadata AS metadata FROM audit_outbox
      WHERE convert_from(event_kind,'UTF8')='setting.update' ORDER BY occurred_at DESC LIMIT 1`,
  );
  const metadata = JSON.stringify(event?.metadata);
  for (const value of ['hr.requestWindowFutureDays', '30', '90'])
    assert.ok(!metadata.includes(`"${value}"`), value);
  await update(h, SettingKey.RequestWindowFutureDays, 90, String(Number(version) + 1));
});

test('two concurrent writes of one key with one expected version: exactly one wins, the other is stale', async () => {
  const h = p('H').secret;
  const version = find(await stack.settings.list(h), SettingKey.ExportMaxRows)?.version ?? '';
  const results = await Promise.allSettled([
    update(h, SettingKey.ExportMaxRows, 4000, version),
    update(h, SettingKey.ExportMaxRows, 3000, version),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.ok(lost?.status === 'rejected' && rejected('stale_version')(lost.reason));
  const history = await stack.settings.history(h, SettingKey.ExportMaxRows, {
    limit: 20,
    offset: 0,
  });
  assert.equal(history?.total, '1');
  assert.equal(
    find(await stack.settings.list(h), SettingKey.ExportMaxRows)?.version,
    String(Number(version) + 1),
  );
  await update(h, SettingKey.ExportMaxRows, 5000, String(Number(version) + 1));
});

test('a default-rate change reaches only employees made official afterwards (no retroactive rewrite)', async () => {
  const h = p('H').secret;
  const root = await stack.freshRoot();

  const input = (code: string) => ({
    code,
    fullName: 'Nhân viên giả',
    hiredOn: '2026-01-05',
    status: 'official' as const,
    annualLeaveMinutes: 'default' as const,
    identity: {
      dateOfBirth: null,
      documentKind: null,
      documentNumber: null,
      taxCode: null,
      gender: null,
      phone: null,
      workEmail: null,
    },
    position: null,
    classification: null,
  });

  const rate = (id: string) =>
    one('SELECT annual_minutes::text AS v FROM leave_rate WHERE employee_id=$1', [id]);

  const first = await stack.employees.create(root, input('SET-001'));
  assert.equal(await rate(first.id), '5760');
  const version =
    find(await stack.settings.list(h), SettingKey.AnnualLeaveDefaultMinutes)?.version ?? '';
  await update(h, SettingKey.AnnualLeaveDefaultMinutes, 7200, version);
  assert.equal(await rate(first.id), '5760');
  const second = await stack.employees.create(root, input('SET-002'));
  assert.equal(await rate(second.id), '7200');
  assert.equal(await rate(first.id), '5760');
  await update(h, SettingKey.AnnualLeaveDefaultMinutes, 5760, String(Number(version) + 1));
});

test('the security page is a view-only allowlist of the values in force, with no setting row behind it', async () => {
  const view = await stack.settings.security(p('H').secret);
  assert.deepEqual(view, {
    freshAuthenticationSeconds: securityPolicy.freshAuthenticationSeconds,
    sessionHours: securityPolicy.sessionHours,
    rateLimitWindowMinutes: securityPolicy.rateLimitWindowMinutes,
    oidcAttemptMinutes: securityPolicy.oidcAttemptMinutes,
    idleMinutes: securityPolicy.idleMinutes,
  });
  assert.deepEqual(Object.values(view ?? {}), [300, 12, 15, 5, 30]);
  assert.equal(JSON.stringify(view).includes('secret'), false);
  // Nothing in the registry can write it: there is no key for it.
  await assert.rejects(
    update(p('H').secret, 'security.sessionHours', 1, '0'),
    ProductInvalidRequest,
  );
});

test('the read repository: defaults without a row, stored values with one, and a corrupt row fails closed', async () => {
  const reads = stack.modules.repositories.settingRead;
  const keys = [SettingKey.RequestMaxDays, SettingKey.CompanyDefaultLocale] as const;

  const read = () => stack.runner.run('read', (tx) => reads.read(tx.manager, keys));

  assert.deepEqual(await read(), { 'hr.requestMaxDays': 31, 'company.defaultLocale': 'vi' });
  const h = p('H').secret;
  await update(h, SettingKey.RequestMaxDays, 10, '0');
  await update(h, SettingKey.CompanyDefaultLocale, 'en', '0');
  assert.deepEqual(await read(), { 'hr.requestMaxDays': 10, 'company.defaultLocale': 'en' });
  // A row the owner forced out of the registry's range is a server error, never a silent default.
  await stack.migration.query(
    `UPDATE system_setting SET value = '99'::jsonb WHERE key = 'hr.requestMaxDays'`,
  );
  await assert.rejects(read(), /invalid/i);
  await stack.migration.query(
    `UPDATE system_setting SET value = '10'::jsonb WHERE key = 'hr.requestMaxDays'`,
  );
  await update(h, SettingKey.RequestMaxDays, 31, '1');
  await update(h, SettingKey.CompanyDefaultLocale, 'vi', '1');
});

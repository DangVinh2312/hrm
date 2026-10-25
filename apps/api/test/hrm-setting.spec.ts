// Pure part of the setting module (ADR 0041 §5, ADR 0045): the code-owned registry and the
// validator of an update. No database: key/type/min/max, unknown keys and shapes are 400 here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { PRODUCT_FRESH_AUTH_SQL } from '../dist/authentication/services/product-identity.service.js';
import { securityIntervals, securityPolicy } from '../dist/config/security-policy.config.js';
import { REPORT_MAX_MONTHS } from '../dist/modules/report/report.validator.js';
import {
  EXPORT_MAX_BYTES,
  EXPORT_MAX_ROWS,
} from '../dist/modules/report/services/excel-export.service.js';
import { MAX_DAYS } from '../dist/modules/work-request/work-request.validator.js';
import {
  SettingKey,
  settingDefinition,
  settingKeys,
  settingRegistry,
  validateSettingValue,
} from '../dist/modules/setting/setting.registry.js';
import {
  parseSettingHistoryQuery,
  parseSettingKey,
  parseSettingUpdate,
} from '../dist/modules/setting/setting.validator.js';

const invalid = (action: () => unknown, label: string) =>
  assert.throws(action, ProductInvalidRequest, label);

test('the registry has exactly the ADR 0041 §5 keys with their defaults and ranges', () => {
  const summary = Object.fromEntries(
    settingKeys.map((key) => {
      const d = settingRegistry[key];
      return [key, d.kind === 'int' ? [d.group, d.default, d.min, d.max] : [d.group, d.default]];
    }),
  );
  assert.deepEqual(summary, {
    'hr.annualLeaveDefaultMinutes': ['rule', 5760, 5760, 175_680],
    'hr.wfhMonthLimit': ['rule', 4, 0, 31],
    'hr.requestWindowPastDays': ['rule', 7, 0, 31],
    'hr.requestWindowFutureDays': ['rule', 90, 0, 365],
    'hr.requestMaxDays': ['rule', 31, 1, 31],
    'report.maxMonths': ['rule', 12, 1, 12],
    'export.maxRows': ['rule', 5000, 1, 5000],
    'export.maxBytes': ['rule', 5_242_880, 1_048_576, 5_242_880],
    'company.name': ['profile', ''],
    'company.defaultLocale': ['profile', 'vi'],
  });
  // Every default is itself a value the registry accepts (so "write the default" is legal).
  for (const key of settingKeys)
    assert.equal(
      validateSettingValue(key, settingRegistry[key].default),
      settingRegistry[key].default,
    );
  assert.equal(settingDefinition('hr.wfhMonthLimit'), settingRegistry[SettingKey.WfhMonthLimit]);
  assert.equal(settingDefinition('hr.unknown'), undefined);
  assert.equal(settingDefinition('toString'), undefined);
});

test('integer settings take exact integers inside min..max and nothing else', () => {
  assert.equal(validateSettingValue(SettingKey.WfhMonthLimit, 0), 0);
  assert.equal(validateSettingValue(SettingKey.WfhMonthLimit, 31), 31);
  for (const bad of [-1, 32, 1.5, '4', null, true, [4], {}, Number.NaN, Infinity, 2 ** 53])
    invalid(() => validateSettingValue(SettingKey.WfhMonthLimit, bad), `${JSON.stringify(bad)}`);
  // The six "only lower" settings cap at the old constant: a value above it is refused.
  for (const [key, ceiling] of [
    [SettingKey.RequestMaxDays, 31],
    [SettingKey.ReportMaxMonths, 12],
    [SettingKey.ExportMaxRows, 5000],
    [SettingKey.ExportMaxBytes, 5_242_880],
  ] as const) {
    assert.equal(validateSettingValue(key, ceiling), ceiling);
    invalid(() => validateSettingValue(key, ceiling + 1), `${key} above ceiling`);
  }
  invalid(() => validateSettingValue(SettingKey.ExportMaxBytes, 1_048_575), 'below bytes floor');
  invalid(() => validateSettingValue(SettingKey.RequestMaxDays, 0), 'zero days');
  invalid(() => validateSettingValue(SettingKey.AnnualLeaveDefaultMinutes, 5759), 'below 12 days');
  invalid(() => validateSettingValue(SettingKey.AnnualLeaveDefaultMinutes, 175_681), 'above DB');
});

test('profile settings: bounded text without control characters, enum of the two locales', () => {
  assert.equal(validateSettingValue(SettingKey.CompanyName, '  Công ty Giả  '), 'Công ty Giả');
  assert.equal(validateSettingValue(SettingKey.CompanyName, ''), '');
  assert.equal(validateSettingValue(SettingKey.CompanyName, 'a'.repeat(120)), 'a'.repeat(120));
  for (const bad of ['a'.repeat(121), 'x\ny', 'x\u0000y', 'x\u007fy', 7, null, ['x']])
    invalid(() => validateSettingValue(SettingKey.CompanyName, bad), String(bad));
  assert.equal(validateSettingValue(SettingKey.CompanyDefaultLocale, 'en'), 'en');
  for (const bad of ['fr', 'EN', '', 1, null])
    invalid(() => validateSettingValue(SettingKey.CompanyDefaultLocale, bad), String(bad));
});

test('an update is exactly {value, expectedVersion} for a key of the route group; version 0 is the unset row', () => {
  assert.deepEqual(
    parseSettingUpdate('rule', 'hr.wfhMonthLimit', { value: 6, expectedVersion: '0' }),
    { key: 'hr.wfhMonthLimit', value: 6, expectedVersion: '0' },
  );
  assert.deepEqual(
    parseSettingUpdate('profile', 'company.name', { value: 'Công ty Giả', expectedVersion: '12' }),
    { key: 'company.name', value: 'Công ty Giả', expectedVersion: '12' },
  );
  const ok = { value: 6, expectedVersion: '1' };
  invalid(() => parseSettingUpdate('rule', 'hr.nope', ok), 'unknown key');
  invalid(
    () => parseSettingUpdate('rule', 'company.name', { ...ok, value: 'x' }),
    'profile key on rule route',
  );
  invalid(() => parseSettingUpdate('profile', 'hr.wfhMonthLimit', ok), 'rule key on profile route');
  invalid(
    () => parseSettingUpdate('rule', 'hr.wfhMonthLimit', { value: 32, expectedVersion: '1' }),
    'range',
  );
  invalid(
    () => parseSettingUpdate('rule', 'hr.wfhMonthLimit', { value: '6', expectedVersion: '1' }),
    'type',
  );
  for (const body of [
    { value: 6 },
    { expectedVersion: '1' },
    { ...ok, extra: 1 },
    { value: 6, expectedVersion: 1 },
    { value: 6, expectedVersion: '01' },
    { value: 6, expectedVersion: '-1' },
    { value: 6, expectedVersion: '1'.repeat(19) },
    null,
    [],
    'x',
  ])
    invalid(() => parseSettingUpdate('rule', 'hr.wfhMonthLimit', body), JSON.stringify(body));
  for (const key of [undefined, null, 7, {}, '__proto__', 'constructor', 'hr.wfhMonthLimit '])
    invalid(() => parseSettingUpdate('rule', key, ok), `${JSON.stringify(key)}`);
});

test('a key and a history page are validated before any operation', () => {
  assert.equal(parseSettingKey('report.maxMonths'), 'report.maxMonths');
  for (const bad of ['report.nope', 7, undefined, 'toString'])
    invalid(() => parseSettingKey(bad), String(bad));
  assert.deepEqual(parseSettingHistoryQuery({}), { limit: 20, offset: 0 });
  assert.deepEqual(parseSettingHistoryQuery({ limit: '50', offset: '10' }), {
    limit: 50,
    offset: 10,
  });
  for (const bad of [{ limit: '0' }, { limit: '101' }, { offset: '10001' }, { key: 'x' }, null])
    invalid(() => parseSettingHistoryQuery(bad), JSON.stringify(bad));
});

test('the "lower only" settings cap at the constants the code still enforces as ceilings', () => {
  assert.equal(settingRegistry[SettingKey.RequestMaxDays].max, MAX_DAYS);
  assert.equal(settingRegistry[SettingKey.ReportMaxMonths].max, REPORT_MAX_MONTHS);
  assert.equal(settingRegistry[SettingKey.ExportMaxRows].max, EXPORT_MAX_ROWS);
  assert.equal(settingRegistry[SettingKey.ExportMaxBytes].max, EXPORT_MAX_BYTES);
  assert.equal(settingRegistry[SettingKey.RequestMaxDays].default, MAX_DAYS);
});

test('the security timings have one source: the values the page shows are the ones the SQL enforces', () => {
  assert.deepEqual(securityPolicy, {
    freshAuthenticationSeconds: 300,
    sessionHours: 12,
    rateLimitWindowMinutes: 15,
    oidcAttemptMinutes: 5,
    idleMinutes: 30,
  });
  assert.equal(securityIntervals.freshAuthentication, "interval '300 seconds'");
  assert.equal(securityIntervals.session, "interval '12 hours'");
  assert.equal(securityIntervals.rateLimitWindow, "interval '15 minutes'");
  assert.equal(securityIntervals.oidcAttempt, "interval '5 minutes'");
  assert.ok(PRODUCT_FRESH_AUTH_SQL.includes(securityIntervals.freshAuthentication));
});

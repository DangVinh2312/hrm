import type { MessageKey } from '../../i18n/i18n.helper';
import type { SettingRow } from './setting.client';

/**
 * Message key stem of each setting the API may return (registry keys of ADR 0045); a key the web
 * does not know is not shown, so a newer API never renders text the web cannot translate.
 */
export const settingLabelStems = {
  'hr.annualLeaveDefaultMinutes': 'setting.field.hrAnnualLeaveDefaultMinutes',
  'hr.wfhMonthLimit': 'setting.field.hrWfhMonthLimit',
  'hr.requestWindowPastDays': 'setting.field.hrRequestWindowPastDays',
  'hr.requestWindowFutureDays': 'setting.field.hrRequestWindowFutureDays',
  'hr.requestMaxDays': 'setting.field.hrRequestMaxDays',
  'report.maxMonths': 'setting.field.reportMaxMonths',
  'export.maxRows': 'setting.field.exportMaxRows',
  'export.maxBytes': 'setting.field.exportMaxBytes',
  'company.name': 'setting.field.companyName',
  'company.defaultLocale': 'setting.field.companyDefaultLocale',
} as const;

export type KnownSettingKey = keyof typeof settingLabelStems;

export const isKnownSetting = (key: string): key is KnownSettingKey =>
  Object.hasOwn(settingLabelStems, key);

export const unitKeys = {
  minutes: 'setting.unit.minutes',
  days: 'setting.unit.days',
  months: 'setting.unit.months',
  rows: 'setting.unit.rows',
  bytes: 'setting.unit.bytes',
} as const satisfies Record<string, MessageKey>;

/** A draft is what the input holds; `undefined` while it is not a value the registry would accept. */
export type Draft = string;

export const draftOf = (row: SettingRow): Draft => String(row.value);

/**
 * The value to send for a draft, or `undefined` when the registry's bounds (sent by the API) would
 * refuse it: an integer inside min..max, text of at most `maxLength` code points without control
 * characters, or one of the listed values. The API validates again; this only stops a request that
 * cannot succeed.
 */
export function draftValue(row: SettingRow, draft: Draft): number | string | undefined {
  switch (row.kind) {
    case 'int': {
      if (!/^-?\d{1,12}$/.test(draft.trim())) return undefined;
      const value = Number(draft);
      return Number.isSafeInteger(value) && value >= row.min && value <= row.max
        ? value
        : undefined;
    }
    case 'text': {
      const text = draft.trim();
      const control = [...text].some(
        (c) => (c.codePointAt(0) ?? 0) < 0x20 || c.codePointAt(0) === 0x7f,
      );
      return [...text].length <= row.maxLength && !control ? text : undefined;
    }
    case 'enum':
      return row.values.includes(draft) ? draft : undefined;
  }
}

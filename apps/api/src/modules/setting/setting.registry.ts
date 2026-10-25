import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';

/**
 * Code-owned registry of the editable settings (ADR 0041 §5, ADR 0045): the key, kind, default and
 * bounds of each. A key outside it cannot be read or written; the effective value is the stored
 * row, or the default here when there is no row (no seed). The upper bound of a "lower only"
 * setting is the constant it replaces, so the old behavior is the ceiling and a value above it is
 * refused. The default of every setting is itself a value the registry accepts.
 */
export const SettingKey = {
  AnnualLeaveDefaultMinutes: 'hr.annualLeaveDefaultMinutes',
  WfhMonthLimit: 'hr.wfhMonthLimit',
  RequestWindowPastDays: 'hr.requestWindowPastDays',
  RequestWindowFutureDays: 'hr.requestWindowFutureDays',
  RequestMaxDays: 'hr.requestMaxDays',
  ReportMaxMonths: 'report.maxMonths',
  ExportMaxRows: 'export.maxRows',
  ExportMaxBytes: 'export.maxBytes',
  CompanyName: 'company.name',
  CompanyDefaultLocale: 'company.defaultLocale',
} as const;

export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey];

/** `rule` is HR rules (permission `updateRule`), `profile` is company information (`updateProfile`). */
export type SettingGroup = 'rule' | 'profile';

export type SettingUnit = 'minutes' | 'days' | 'months' | 'rows' | 'bytes';

export interface IntDefinition {
  readonly kind: 'int';
  readonly group: SettingGroup;
  readonly unit: SettingUnit;
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export interface TextDefinition {
  readonly kind: 'text';
  readonly group: SettingGroup;
  readonly default: string;
  /** Code points, after trimming; control characters are refused. 0 means "use the product name". */
  readonly maxLength: number;
}

export interface EnumDefinition {
  readonly kind: 'enum';
  readonly group: SettingGroup;
  readonly default: string;
  readonly values: readonly string[];
}

export type SettingDefinition = IntDefinition | TextDefinition | EnumDefinition;

export const settingRegistry = {
  // 12 days up to a full year of working days, the CHECK of `leave_rate` (ADR 0039).
  [SettingKey.AnnualLeaveDefaultMinutes]: {
    kind: 'int',
    group: 'rule',
    unit: 'minutes',
    default: 5760,
    min: 5760,
    max: 175_680,
  },
  [SettingKey.WfhMonthLimit]: {
    kind: 'int',
    group: 'rule',
    unit: 'days',
    default: 4,
    min: 0,
    max: 31,
  },
  [SettingKey.RequestWindowPastDays]: {
    kind: 'int',
    group: 'rule',
    unit: 'days',
    default: 7,
    min: 0,
    max: 31,
  },
  [SettingKey.RequestWindowFutureDays]: {
    kind: 'int',
    group: 'rule',
    unit: 'days',
    default: 90,
    min: 0,
    max: 365,
  },
  [SettingKey.RequestMaxDays]: {
    kind: 'int',
    group: 'rule',
    unit: 'days',
    default: 31,
    min: 1,
    max: 31,
  },
  [SettingKey.ReportMaxMonths]: {
    kind: 'int',
    group: 'rule',
    unit: 'months',
    default: 12,
    min: 1,
    max: 12,
  },
  [SettingKey.ExportMaxRows]: {
    kind: 'int',
    group: 'rule',
    unit: 'rows',
    default: 5000,
    min: 1,
    max: 5000,
  },
  [SettingKey.ExportMaxBytes]: {
    kind: 'int',
    group: 'rule',
    unit: 'bytes',
    default: 5_242_880,
    min: 1_048_576,
    max: 5_242_880,
  },
  [SettingKey.CompanyName]: { kind: 'text', group: 'profile', default: '', maxLength: 120 },
  [SettingKey.CompanyDefaultLocale]: {
    kind: 'enum',
    group: 'profile',
    default: 'vi',
    values: ['vi', 'en'],
  },
} as const satisfies Record<SettingKey, SettingDefinition>;

export const settingKeys: readonly SettingKey[] = Object.values(SettingKey);

/** The scalar a key stores: a number for `int`, a string otherwise. */
export type SettingValueOf<K extends SettingKey> = (typeof settingRegistry)[K] extends {
  readonly kind: 'int';
}
  ? number
  : string;

export type SettingValues<K extends SettingKey> = { readonly [P in K]: SettingValueOf<P> };

/** The definition of a registered key, `undefined` for anything else (inherited names included). */
export function settingDefinition(key: unknown): SettingDefinition | undefined {
  return typeof key === 'string' && Object.hasOwn(settingRegistry, key)
    ? settingRegistry[key as SettingKey]
    : undefined;
}

const hasControl = (text: string) =>
  [...text].some((c) => (c.codePointAt(0) ?? 0) < 0x20 || c.codePointAt(0) === 0x7f);

/**
 * The normalized value of `key` for `input`, or ProductInvalidRequest (HTTP 400): an unknown key,
 * a wrong type, a fraction or a value outside min..max / the enum. The one check used by the
 * validator, the command (which does not trust its caller) and the read of a stored row.
 */
export function validateSettingValue(key: unknown, input: unknown): number | string {
  const definition = settingDefinition(key);
  if (!definition) throw new ProductInvalidRequest('Unknown setting');
  switch (definition.kind) {
    case 'int':
      if (
        typeof input !== 'number' ||
        !Number.isSafeInteger(input) ||
        input < definition.min ||
        input > definition.max
      )
        throw new ProductInvalidRequest('Invalid setting value');
      return input;
    case 'text': {
      if (typeof input !== 'string') throw new ProductInvalidRequest('Invalid setting value');
      const text = input.trim();
      if ([...text].length > definition.maxLength || hasControl(text))
        throw new ProductInvalidRequest('Invalid setting value');
      return text;
    }
    case 'enum':
      if (typeof input !== 'string' || !definition.values.includes(input))
        throw new ProductInvalidRequest('Invalid setting value');
      return input;
  }
}

/**
 * The value of a stored row. A row outside the registry is not a request error: it means the table
 * was changed behind the application, so reading it fails closed (a server error) instead of
 * silently using a default.
 */
export function storedSettingValue(key: SettingKey, raw: unknown): number | string {
  try {
    return validateSettingValue(key, raw);
  } catch (error) {
    if (error instanceof ProductInvalidRequest)
      throw new Error('Stored setting is invalid', { cause: error });
    throw error;
  }
}

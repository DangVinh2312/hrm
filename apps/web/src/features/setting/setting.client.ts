import { z } from 'zod';
import type { HttpClient } from '../../infrastructure/http.client';

/** One page of history; the API bounds `limit` (default 20, max 100). */
export const SETTING_HISTORY_PAGE_SIZE = 10;

const base = {
  key: z.string().min(3).max(64),
  group: z.enum(['rule', 'profile']),
  version: z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
  isDefault: z.boolean(),
  updatedAt: z.string().nullable(),
};

const intSetting = z.object({
  ...base,
  kind: z.literal('int'),
  unit: z.enum(['minutes', 'days', 'months', 'rows', 'bytes']),
  value: z.number().int(),
  default: z.number().int(),
  min: z.number().int(),
  max: z.number().int(),
});
const textSetting = z.object({
  ...base,
  kind: z.literal('text'),
  value: z.string(),
  default: z.string(),
  maxLength: z.number().int().positive(),
});
const enumSetting = z.object({
  ...base,
  kind: z.literal('enum'),
  value: z.string(),
  default: z.string(),
  values: z.array(z.string()).min(1).max(8),
});

const settingSchema = z.discriminatedUnion('kind', [intSetting, textSetting, enumSetting]);
export type SettingRow = z.infer<typeof settingSchema>;

export type SettingGroup = SettingRow['group'];

const listSchema = z.object({
  settings: z.array(settingSchema).max(50),
  canUpdate: z.object({ rule: z.boolean(), profile: z.boolean() }),
});
export type SettingList = z.infer<typeof listSchema>;

const profileSchema = z.object({ companyName: z.string().max(120), defaultLocale: z.string() });
export type CompanyProfile = z.infer<typeof profileSchema>;

const securitySchema = z.object({
  freshAuthenticationSeconds: z.number().int().positive(),
  sessionHours: z.number().int().positive(),
  rateLimitWindowMinutes: z.number().int().positive(),
  oidcAttemptMinutes: z.number().int().positive(),
  idleMinutes: z.number().int().positive(),
});
export type SecurityPolicy = z.infer<typeof securitySchema>;

const scalar = z.union([z.number(), z.string()]);
const historySchema = z.object({
  items: z
    .array(
      z.object({
        version: z.string(),
        oldValue: scalar,
        newValue: scalar,
        changedAt: z.string(),
      }),
    )
    .max(100),
  total: z.string(),
});
export type SettingHistory = z.infer<typeof historySchema>;

const updatedSchema = z.object({ version: z.string() });

export interface SettingClient {
  /** `setting.read`: every key with its value, version and the groups the caller may update. */
  list(signal?: AbortSignal): Promise<SettingList>;

  /** `setting.readProfile`: company name and default language (shown inside the app only). */
  profile(signal?: AbortSignal): Promise<CompanyProfile>;

  /** `setting.read`: the session timings in force; view only. */
  security(signal?: AbortSignal): Promise<SecurityPolicy>;

  /** `setting.read`: changes of one key, newest first. */
  history(key: string, page: number, signal?: AbortSignal): Promise<SettingHistory>;

  /** `setting.updateRule` / `updateProfile`; `expectedVersion` is `'0'` while the key has no row. */
  update(
    group: SettingGroup,
    key: string,
    value: number | string,
    expectedVersion: string,
  ): Promise<{ readonly version: string }>;
}

const path = (suffix: string) => `/api/administration/settings${suffix}`;

export function createSettingClient(http: HttpClient): SettingClient {
  return {
    list: (signal) => http.request(path(''), listSchema, signal ? { signal } : {}),
    profile: (signal) => http.request(path('/profile'), profileSchema, signal ? { signal } : {}),
    security: (signal) => http.request(path('/security'), securitySchema, signal ? { signal } : {}),
    history: (key, page, signal) =>
      http.request(
        `${path(`/${encodeURIComponent(key)}/history`)}?limit=${SETTING_HISTORY_PAGE_SIZE}&offset=${(page - 1) * SETTING_HISTORY_PAGE_SIZE}`,
        historySchema,
        signal ? { signal } : {},
      ),
    update: (group, key, value, expectedVersion) =>
      http.request(path(`/${group}/${encodeURIComponent(key)}`), updatedSchema, {
        method: 'PUT',
        body: { value, expectedVersion },
      }),
  };
}

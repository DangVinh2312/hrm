import type { EntityManager } from 'typeorm';
import type {
  ProductQuery,
  ProductQueryContext,
} from '../../../authorization/services/product-authority.service.js';
import { type StoredSetting, settingViews } from '../setting-view.helper.js';
import { SettingAction, SettingResource } from '../setting-authorization.types.js';
import {
  type SettingKey,
  type SettingValues,
  settingDefinition,
  settingRegistry,
  storedSettingValue,
} from '../setting.registry.js';
import type { SettingHistoryView, SettingProfileView, SettingView } from '../setting.types.js';
import { securityPolicy, type SecurityPolicyView } from '../../../config/security-policy.config.js';

const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Reads of the settings. `read` is for business transactions: it uses the manager of the caller's
 * own transaction (no cache, no TTL, no lock), so a decision uses the value committed when it
 * reads. The registered queries serve the settings page behind `setting.read` / `readProfile`; the
 * plan's scope is the singleton anchor of the resource, so a caller without the grant reaches
 * nothing (`undefined`, HTTP 404), as for the work calendar.
 */
export class SettingReadRepository {
  /**
   * The values of `keys` in force: the stored row, or the registry default when there is none. One
   * statement. A stored row outside the registry is a server error (fail closed).
   */
  async read<K extends SettingKey>(
    manager: EntityManager,
    keys: readonly K[],
  ): Promise<SettingValues<K>> {
    for (const key of keys) if (!settingDefinition(key)) throw new TypeError('Unknown setting');
    const rows = await manager.query<{ key: string; value: unknown }[]>(
      'SELECT key, value FROM system_setting WHERE key = ANY(CAST($1 AS text[]))',
      [keys],
    );
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    return Object.fromEntries(
      keys.map((key) => [
        key,
        stored.has(key) ? storedSettingValue(key, stored.get(key)) : settingRegistry[key].default,
      ]),
    ) as SettingValues<K>;
  }

  /** Whether the plan of the action reaches the settings anchor (the caller holds the grant). */
  async #reaches({ tx, scope }: ProductQueryContext): Promise<boolean> {
    const [row] = await tx.manager.query<{ ok: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM setting_anchor r WHERE ${scope.sql}) AS ok`,
      [...scope.parameters],
    );
    return row?.ok === true;
  }

  /** setting.read: every registered key with its value in force and its version. */
  readonly list: ProductQuery<undefined, readonly SettingView[] | undefined> = {
    resource: SettingResource.Setting,
    action: SettingAction.Read,
    run: async (context) => {
      if (!(await this.#reaches(context))) return undefined;
      const rows = await context.tx.manager.query<StoredSetting[]>(
        `SELECT key, value, version::text AS version, ${instant('updated_at')} AS "updatedAt" FROM system_setting`,
      );
      return settingViews(rows);
    },
  };

  /** setting.readProfile: the two company fields shown inside the app, nothing else. */
  readonly profile: ProductQuery<undefined, SettingProfileView | undefined> = {
    resource: SettingResource.Setting,
    action: SettingAction.ReadProfile,
    run: async (context) => {
      if (!(await this.#reaches(context))) return undefined;
      const values = await this.read(context.tx.manager, ['company.name', 'company.defaultLocale']);
      return {
        companyName: values['company.name'],
        defaultLocale: values['company.defaultLocale'],
      };
    },
  };

  /** setting.read: the changes of one key, newest first; empty for a key nobody wrote. */
  readonly history: ProductQuery<
    { readonly key: SettingKey; readonly limit: number; readonly offset: number },
    SettingHistoryView | undefined
  > = {
    resource: SettingResource.Setting,
    action: SettingAction.Read,
    run: async (context, input) => {
      if (!(await this.#reaches(context))) return undefined;
      const { manager } = context.tx;
      const [count] = await manager.query<{ total: string }[]>(
        'SELECT count(*)::text AS total FROM system_setting_history WHERE key = $1',
        [input.key],
      );
      const items = await manager.query<
        { version: string; oldValue: unknown; newValue: unknown; changedAt: string }[]
      >(
        `SELECT version::text AS version, old_value AS "oldValue", new_value AS "newValue",
                ${instant('changed_at')} AS "changedAt"
           FROM system_setting_history WHERE key = $1
          ORDER BY version DESC LIMIT $2 OFFSET $3`,
        [input.key, input.limit, input.offset],
      );
      return {
        items: items.map((item) => ({
          version: item.version,
          oldValue: storedSettingValue(input.key, item.oldValue),
          newValue: storedSettingValue(input.key, item.newValue),
          changedAt: item.changedAt,
        })),
        total: count?.total ?? '0',
      };
    },
  };

  /**
   * setting.read: the session/authentication timings in force, from the one code-owned policy (the idle value is display only, see security-policy.config.ts)
   * (ADR 0045). View only; not a setting and not stored, so nothing here can be written.
   */
  readonly security: ProductQuery<undefined, SecurityPolicyView | undefined> = {
    resource: SettingResource.Setting,
    action: SettingAction.Read,
    run: async (context) => ((await this.#reaches(context)) ? { ...securityPolicy } : undefined),
  };
}

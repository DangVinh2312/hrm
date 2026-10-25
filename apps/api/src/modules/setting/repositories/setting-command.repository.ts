import { ProductInvalidRequest } from '../../../authorization/product-data.gateway.js';
import {
  ProductCommandRejected,
  type ProductCommand,
  type ProductCommandContext,
} from '../../../authorization/services/product-authority.service.js';
import { SETTING_ID } from '../../permission/permission-database.helper.js';
import { SettingAction, SettingResource } from '../setting-authorization.types.js';
import {
  type SettingGroup,
  type SettingKey,
  settingDefinition,
  storedSettingValue,
  validateSettingValue,
} from '../setting.registry.js';
import { parseSettingVersion } from '../setting.validator.js';
import type { SettingUpdateInput } from '../setting.types.js';

type SettingResult = { readonly version: string };

/**
 * The two update commands (Q3). Both run in `write` mode (shared fence) on the settings anchor,
 * which `execute` locks FOR NO KEY UPDATE, so writes of any key serialize and the later of two
 * writers of one key sees the new version and is refused as stale. A command does not trust its
 * caller: it re-validates the key, the group and the value against the registry.
 */
export class SettingCommandRepository {
  /** setting.updateRule: the HR rules group. */
  readonly updateRule = this.#command(SettingAction.UpdateRule, 'rule');

  /** setting.updateProfile: company information. */
  readonly updateProfile = this.#command(SettingAction.UpdateProfile, 'profile');

  #command(
    action: SettingAction,
    group: SettingGroup,
  ): ProductCommand<SettingUpdateInput, SettingResult> {
    return {
      resource: SettingResource.Setting,
      action,
      mode: 'write',
      target: () => SETTING_ID,
      run: (ctx, input) => this.#apply(ctx, group, input),
    };
  }

  /**
   * One change = one new version of one key. The stored row (or the registry default when none) is
   * the old value; the history records old and new in the same transaction and the audit event
   * names the settings record only (the key and the values live in the history, not in audit).
   * Nothing else is touched: leave rates, requests and period snapshots already written keep their
   * values (no retroactive effect).
   */
  async #apply(
    ctx: ProductCommandContext,
    group: SettingGroup,
    input: SettingUpdateInput,
  ): Promise<SettingResult> {
    const definition = settingDefinition(input.key);
    if (!definition || definition.group !== group)
      throw new ProductInvalidRequest('Unknown setting');
    const key: SettingKey = input.key;
    const value = validateSettingValue(key, input.value);
    const expected = parseSettingVersion(input.expectedVersion);
    const { manager } = ctx.tx;
    const [current] = await manager.query<{ value: unknown; version: string }[]>(
      'SELECT value, version::text AS version FROM system_setting WHERE key = $1 FOR UPDATE',
      [key],
    );
    if ((current?.version ?? '0') !== expected) throw new ProductCommandRejected('stale_version');
    const old = current ? storedSettingValue(key, current.value) : definition.default;
    if (old === value) throw new ProductCommandRejected('unchanged');
    const [written] = current
      ? await manager.query<{ version: string }[]>(
          // A CTE: TypeORM answers a bare UPDATE ... RETURNING with [rows, count], not the rows.
          `WITH updated AS (
             UPDATE system_setting SET value = CAST($2 AS jsonb), version = version + 1,
                    updated_at = statement_timestamp(), updated_by = $3
              WHERE key = $1 RETURNING version)
           SELECT version::text AS version FROM updated`,
          [key, JSON.stringify(value), ctx.actor.id],
        )
      : await manager.query<{ version: string }[]>(
          `INSERT INTO system_setting(key, value, version, updated_at, updated_by)
           VALUES ($1, CAST($2 AS jsonb), 1, statement_timestamp(), $3)
           RETURNING version::text AS version`,
          [key, JSON.stringify(value), ctx.actor.id],
        );
    if (!written) throw new Error('Setting write returned no row');
    await manager.query(
      `INSERT INTO system_setting_history(key, version, old_value, new_value, changed_by, changed_at)
       VALUES ($1, CAST($2 AS int8), CAST($3 AS jsonb), CAST($4 AS jsonb), $5, statement_timestamp())`,
      [key, written.version, JSON.stringify(old), JSON.stringify(value), ctx.actor.id],
    );
    await ctx.audit('setting.update', {
      resource: SettingResource.Setting,
      key: ctx.target.key,
      objectId: ctx.target.objectId,
    });
    return { version: written.version };
  }
}

import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import {
  type InputPage,
  inputBody,
  inputPageQuery,
} from '../../infrastructure/helpers/input-validation.helper.js';
import {
  type SettingGroup,
  type SettingKey,
  settingDefinition,
  validateSettingValue,
} from './setting.registry.js';
import type { SettingUpdateInput } from './setting.types.js';

/** A key of the registry (any group), for the history route. */
export function parseSettingKey(value: unknown): SettingKey {
  if (!settingDefinition(value)) throw new ProductInvalidRequest('Unknown setting');
  return value as SettingKey;
}

/** `?limit=&offset=` only, under the shared page budget (default 20, max 100). */
export function parseSettingHistoryQuery(query: unknown): InputPage {
  const { limit, offset } = inputPageQuery(query);
  return { limit, offset };
}

/** Optimistic version of a setting: `0` is "no row yet", then the positive int8 as text. */
export function parseSettingVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(value))
    throw new ProductInvalidRequest('Invalid version');
  return value;
}

/**
 * PUT body `{value, expectedVersion}` for the key in the route. The key must belong to the group
 * of the route (a rule key cannot be written through the profile route and the other way round),
 * so the permission that was checked is the one the key needs.
 */
export function parseSettingUpdate(
  group: SettingGroup,
  key: unknown,
  body: unknown,
): SettingUpdateInput {
  const definition = settingDefinition(key);
  if (!definition || definition.group !== group) throw new ProductInvalidRequest('Unknown setting');
  const input = inputBody(body, ['value', 'expectedVersion']);
  return {
    key: key as SettingKey,
    value: validateSettingValue(key, input.value),
    expectedVersion: parseSettingVersion(input.expectedVersion),
  };
}

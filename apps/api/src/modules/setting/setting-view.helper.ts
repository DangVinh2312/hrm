import {
  type SettingKey,
  settingKeys,
  settingRegistry,
  storedSettingValue,
} from './setting.registry.js';
import type { SettingView } from './setting.types.js';

/** A stored row of `system_setting` as the queries select it. */
export interface StoredSetting {
  readonly key: string;
  readonly value: unknown;
  readonly version: string;
  readonly updatedAt: string;
}

/**
 * Every registered key with the value in force: the stored row, or the code default at version 0
 * when there is none. Rows of keys the registry does not know are ignored (they cannot be written
 * through the application). Order is the registry's.
 */
export function settingViews(rows: readonly StoredSetting[]): SettingView[] {
  const stored = new Map(rows.map((row) => [row.key, row]));
  return settingKeys.map((key) => settingView(key, stored.get(key)));
}

function settingView(key: SettingKey, row: StoredSetting | undefined): SettingView {
  const definition = settingRegistry[key];
  const base = {
    key,
    group: definition.group,
    default: definition.default,
    value: row ? storedSettingValue(key, row.value) : definition.default,
    version: row?.version ?? '0',
    isDefault: row === undefined,
    updatedAt: row?.updatedAt ?? null,
  };
  switch (definition.kind) {
    case 'int':
      return {
        ...base,
        kind: 'int',
        unit: definition.unit,
        min: definition.min,
        max: definition.max,
      };
    case 'text':
      return { ...base, kind: 'text', maxLength: definition.maxLength };
    case 'enum':
      return { ...base, kind: 'enum', values: definition.values };
  }
}

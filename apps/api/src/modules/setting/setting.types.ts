import type { SettingGroup, SettingKey, SettingUnit } from './setting.registry.js';

/** A validated update; `expectedVersion` is `'0'` for a key with no row yet. */
export interface SettingUpdateInput {
  readonly key: SettingKey;
  readonly value: number | string;
  readonly expectedVersion: string;
}

interface SettingViewBase {
  readonly key: SettingKey;
  readonly group: SettingGroup;
  readonly value: number | string;
  readonly default: number | string;
  /** int8 as decimal string; `'0'` while the key has no row (the default is in force). */
  readonly version: string;
  readonly isDefault: boolean;
  /** UTC instant of the last change, `null` while the default is in force. */
  readonly updatedAt: string | null;
}

export type SettingView = SettingViewBase &
  (
    | {
        readonly kind: 'int';
        readonly unit: SettingUnit;
        readonly min: number;
        readonly max: number;
      }
    | { readonly kind: 'text'; readonly maxLength: number }
    | { readonly kind: 'enum'; readonly values: readonly string[] }
  );

/** `setting.read`: every registered key with its value in force. */
export interface SettingListView {
  readonly settings: readonly SettingView[];
  /** Which groups the caller may update (display hint; the update authorizes itself). */
  readonly canUpdate: { readonly rule: boolean; readonly profile: boolean };
}

/** `setting.readProfile`: company information shown inside the app. */
export interface SettingProfileView {
  readonly companyName: string;
  readonly defaultLocale: string;
}

export interface SettingHistoryItem {
  readonly version: string;
  readonly oldValue: number | string;
  readonly newValue: number | string;
  readonly changedAt: string;
}

export interface SettingHistoryView {
  readonly items: readonly SettingHistoryItem[];
  /** int8 as decimal string. */
  readonly total: string;
}

import en from './locales/en.json';
import vi from './locales/vi.json';

export const locales = ['vi', 'en'] as const;

export type Locale = (typeof locales)[number];

/** `vi` is the source of keys; `en` must define each one (compile time here, set equality in root `test/locale-keys.spec.ts`). */
export type MessageKey = keyof typeof vi;

/** Keys the API may answer with (`{ statusCode, code }`); exactly the API's closed set. */
export type ErrorMessageKey = Extract<MessageKey, `error.${string}`>;

export const DEFAULT_LOCALE: Locale = 'vi';

/** Endonyms: each language is listed in its own name, whatever the current locale. */
export const localeNames: Readonly<Record<Locale, string>> = { vi: 'Tiếng Việt', en: 'English' };

const messages: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { vi, en };

const STORAGE_KEY = 'hrm.locale';

export function translate(locale: Locale, key: MessageKey): string {
  return messages[locale][key];
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

export function isMessageKey(value: unknown): value is MessageKey {
  return typeof value === 'string' && Object.hasOwn(vi, value);
}

/** Only keys of our own dictionary are accepted, so a response can never choose displayed text. */
export function isErrorMessageKey(value: unknown): value is ErrorMessageKey {
  return isMessageKey(value) && value.startsWith('error.');
}

/** Reading `window.localStorage` itself throws when site data is blocked. */
export function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The language is a non-sensitive preference; storage may be missing or blocked. */
export function readStoredLocale(storage: Pick<Storage, 'getItem'> | undefined): Locale {
  try {
    const value = storage?.getItem(STORAGE_KEY);
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function storeLocale(storage: Pick<Storage, 'setItem'> | undefined, locale: Locale): void {
  try {
    storage?.setItem(STORAGE_KEY, locale);
  } catch {
    // shortcut: the choice then lasts for this page only; acceptable for a display preference.
  }
}

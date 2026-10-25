import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { type Locale, type MessageKey, storeLocale, translate } from './i18n.helper';

export interface I18nContextValue {
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly setLocale: (locale: Locale) => void;

  /**
   * Uses a language without remembering it as the person's choice: the company default for
   * someone who has not chosen one (ADR 0041 §5). A later choice through `setLocale` is stored.
   */
  readonly adoptLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

/**
 * One locale per app instance. The initial value comes from the composition root, so tests and
 * the browser choose it explicitly; a change is remembered in `storage` when it is given.
 */
export function I18nProvider(props: {
  readonly initialLocale: Locale;
  readonly storage?: Pick<Storage, 'setItem'>;
  readonly children: ReactNode;
}) {
  const { storage, children } = props;
  const [locale, setCurrent] = useState(props.initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback(
    (next: Locale) => {
      setCurrent(next);
      storeLocale(storage, next);
    },
    [storage],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, t: (key) => translate(locale, key), setLocale, adoptLocale: setCurrent }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

import { DatesProvider } from '@mantine/dates';
import 'dayjs/locale/vi';
import type { ReactNode } from 'react';
import { useI18n } from './i18n.provider';

/** Calendar labels and first weekday follow the chosen UI language (Monday first, Vietnam). */
export function LocalizedDates(props: { readonly children: ReactNode }) {
  const { locale } = useI18n();
  return (
    <DatesProvider settings={{ locale, firstDayOfWeek: 1, consistentWeeks: true }}>
      {props.children}
    </DatesProvider>
  );
}

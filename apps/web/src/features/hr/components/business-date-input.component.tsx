import { DateInput, type DateInputProps } from '@mantine/dates';
import { IconCalendar } from '@tabler/icons-react';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { useI18n } from '../../../i18n/i18n.provider';

dayjs.extend(customParseFormat);

/**
 * Mantine's default parser is lenient: `31/02/2026` rolls over to 3 March and unmatched text falls
 * back to `new Date()` (US order, machine timezone). Typed dates must be a real calendar day in
 * day-first order with a four-digit year, otherwise the value stays empty.
 */
function parseBusinessDate(text: string): string | null {
  const date = dayjs(text.trim(), ['DD/MM/YYYY', 'D/M/YYYY'], true);
  return date.isValid() ? date.format('YYYY-MM-DD') : null;
}

/**
 * Business date field (ADR 0018): shown and typed as DD/MM/YYYY (design system §6), stored and
 * sent as `YYYY-MM-DD` — Mantine date values are plain date strings, never a Date in a timezone.
 * A cleared field reports `''` so the form schemas see "not provided".
 */
export function BusinessDateInput(
  props: Omit<DateInputProps, 'onChange' | 'valueFormat' | 'dateParser'> & {
    readonly onChange?: (value: string) => void;
  },
) {
  const { t } = useI18n();
  const { onChange, ...rest } = props;
  return (
    <DateInput
      valueFormat="DD/MM/YYYY"
      dateParser={parseBusinessDate}
      placeholder={t('common.datePlaceholder')}
      leftSection={<IconCalendar size={18} stroke={1.75} aria-hidden />}
      clearable
      {...rest}
      onChange={(value) => onChange?.(value ?? '')}
    />
  );
}

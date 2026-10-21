import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { BusinessDateInput } from '../../hr/components/business-date-input.component';
import { MutationError } from '../../hr/components/mutation-error.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { isMessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { isWeekday, refreshOnConflict, useCalendarRefresh } from '../work-calendar.helper';

// Mirrors the API validator; the API still validates everything.
const holidaySchema = z.object({
  date: z
    .string()
    .pipe(z.iso.date('calendar.form.dateInvalid'))
    .refine(isWeekday, 'calendar.form.weekend'),
  name: z
    .string()
    .trim()
    .min(1, 'calendar.form.nameRequired')
    .max(200, 'calendar.form.nameRequired'),
});
type HolidayValues = z.input<typeof holidaySchema>;

const makeupSchema = z.object({
  date: z
    .string()
    .pipe(z.iso.date('calendar.form.dateInvalid'))
    .refine((date) => !isWeekday(date), 'calendar.form.weekday'),
});
type MakeupValues = z.input<typeof makeupSchema>;

export function HolidayForm(props: {
  readonly expectedVersion: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { workCalendar } = useHrServices();
  const refresh = useCalendarRefresh();
  const form = useForm<HolidayValues>({
    mode: 'uncontrolled',
    initialValues: { date: '', name: '' },
    validate: schemaResolver(holidaySchema, { sync: true }),
  });
  const add = useMutation({
    mutationFn: (values: HolidayValues) => {
      const parsed = holidaySchema.parse(values);
      return workCalendar.setDay(parsed.date, {
        expectedVersion: props.expectedVersion,
        holiday: parsed.name,
      });
    },
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
    onError: (error) => refreshOnConflict(error, refresh),
  });
  const field = (name: keyof HolidayValues) => {
    const input = form.getInputProps(name);
    const error: unknown = input.error;
    return { ...input, error: isMessageKey(error) ? t(error) : undefined };
  };
  return (
    <form onSubmit={form.onSubmit((values) => add.mutate(values))} noValidate>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('calendar.holidays.addHint')}
        </Text>
        <MutationError error={add.error} />
        <BusinessDateInput
          label={t('calendar.holidays.date')}
          withAsterisk
          key={form.key('date')}
          {...field('date')}
        />
        <TextInput
          label={t('calendar.holidays.name')}
          maxLength={200}
          withAsterisk
          key={form.key('name')}
          {...field('name')}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={add.isPending}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/** Marks one Saturday/Sunday as a full workday with the standard shifts. */
export function MakeupForm(props: {
  readonly expectedVersion: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { workCalendar } = useHrServices();
  const refresh = useCalendarRefresh();
  const form = useForm<MakeupValues>({
    mode: 'uncontrolled',
    initialValues: { date: '' },
    validate: schemaResolver(makeupSchema, { sync: true }),
  });
  const add = useMutation({
    mutationFn: (values: MakeupValues) =>
      workCalendar.setDay(makeupSchema.parse(values).date, {
        expectedVersion: props.expectedVersion,
        makeup: true,
      }),
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
    onError: (error) => refreshOnConflict(error, refresh),
  });
  const input = form.getInputProps('date');
  const error: unknown = input.error;
  return (
    <form onSubmit={form.onSubmit((values) => add.mutate(values))} noValidate>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('calendar.makeup.addHint')}
        </Text>
        <MutationError error={add.error} />
        <BusinessDateInput
          label={t('calendar.holidays.date')}
          withAsterisk
          key={form.key('date')}
          {...input}
          error={isMessageKey(error) ? t(error) : undefined}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={add.isPending}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

import { Button, Group, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { BusinessDateInput } from '../../../components/business-date-input.component';
import { MutationError } from '../../account/components/mutation-error.component';
import { useWorkCalendarClient } from '../work-calendar-services.provider';
import { isoWeekdayName } from '../../../components/week-frames.helper';
import { isMessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import type { CompanySchedule } from '../work-calendar.client';
import {
  MAX_HOLIDAY_DAYS,
  calendarDaysBetween,
  companyWorksOn,
  refreshOnConflict,
  useCalendarRefresh,
  useCompanySchedule,
  workdaysInRange,
} from '../work-calendar.helper';

// Mirrors the API validator; the API still validates everything.
const holidaySchemaOf = (versions: CompanySchedule['versions']) =>
  z
    .object({
      from: z.string().pipe(z.iso.date('calendar.form.dateInvalid')),
      to: z.string().pipe(z.iso.date('calendar.form.dateInvalid')),
      name: z
        .string()
        .trim()
        .min(1, 'calendar.form.nameRequired')
        .max(200, 'calendar.form.nameRequired'),
    })
    .superRefine((value, ctx) => {
      const days = calendarDaysBetween(value.from, value.to);
      const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['to'], message });
      if (days === 0) issue('calendar.form.rangeOrder');
      else if (days > MAX_HOLIDAY_DAYS) issue('calendar.form.rangeTooLong');
      else if (workdaysInRange(value.from, value.to, versions) === 0)
        issue('calendar.form.noWorkday');
    });
type HolidayValues = z.input<ReturnType<typeof holidaySchemaOf>>;

const makeupSchemaOf = (versions: CompanySchedule['versions']) =>
  z.object({
    date: z
      .string()
      .pipe(z.iso.date('calendar.form.dateInvalid'))
      .refine((date) => companyWorksOn(date, versions) !== true, 'calendar.form.makeupWorkday'),
    asWeekday: z.enum(['1', '2', '3', '4', '5', '6', '7']),
    frameSource: z.enum(['company', 'employee']),
  });
type MakeupValues = z.input<ReturnType<typeof makeupSchemaOf>>;

export function HolidayForm(props: {
  readonly expectedVersion: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const workCalendar = useWorkCalendarClient();
  const refresh = useCalendarRefresh();
  // Until the schedule loads every day counts; the API decides anyway.
  const versions = useCompanySchedule().data?.versions ?? [];
  const holidaySchema = holidaySchemaOf(versions);
  const form = useForm<HolidayValues>({
    mode: 'controlled',
    initialValues: { from: '', to: '', name: '' },
    validate: (values) => schemaResolver(holidaySchema, { sync: true })(values),
  });
  const add = useMutation({
    mutationFn: (values: HolidayValues) => {
      const parsed = holidaySchema.parse(values);
      return workCalendar.setHolidays({
        expectedVersion: props.expectedVersion,
        from: parsed.from,
        to: parsed.to,
        name: parsed.name,
      });
    },
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
    onError: (error) => refreshOnConflict(error, refresh),
  });
  // Controlled form: the count follows the two date fields as they change.
  const values = form.values;
  const applied =
    z.iso.date().safeParse(values.from).success && z.iso.date().safeParse(values.to).success
      ? workdaysInRange(values.from, values.to, versions)
      : 0;
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
          label={t('calendar.holidays.from')}
          withAsterisk
          key={form.key('from')}
          {...field('from')}
        />
        <BusinessDateInput
          label={t('calendar.holidays.to')}
          withAsterisk
          key={form.key('to')}
          {...field('to')}
        />
        {applied > 0 && (
          <Text size="sm" c="dimmed" aria-live="polite">
            {t('calendar.holidays.dayCount')}: {applied}
          </Text>
        )}
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

/** Makes one company day off a workday with the hours of a weekday. */
export function MakeupForm(props: {
  readonly expectedVersion: string;
  readonly onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const workCalendar = useWorkCalendarClient();
  const refresh = useCalendarRefresh();
  // A date the week in force then works is refused before the API; an unknown week passes.
  const makeupSchema = makeupSchemaOf(useCompanySchedule().data?.versions ?? []);
  const form = useForm<MakeupValues>({
    mode: 'uncontrolled',
    initialValues: { date: '', asWeekday: '1', frameSource: 'company' },
    validate: (values) => schemaResolver(makeupSchema, { sync: true })(values),
  });
  const add = useMutation({
    mutationFn: (values: MakeupValues) => {
      const parsed = makeupSchema.parse(values);
      return workCalendar.setDay(parsed.date, {
        expectedVersion: props.expectedVersion,
        makeup: { asWeekday: Number(parsed.asWeekday), frameSource: parsed.frameSource },
      });
    },
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
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label={t('calendar.makeup.asWeekday')}
            allowDeselect={false}
            data={['1', '2', '3', '4', '5', '6', '7'].map((value) => ({
              value,
              label: isoWeekdayName(Number(value), locale),
            }))}
            key={form.key('asWeekday')}
            {...form.getInputProps('asWeekday')}
          />
          <Select
            label={t('calendar.makeup.frameSource')}
            allowDeselect={false}
            data={(['company', 'employee'] as const).map((value) => ({
              value,
              label: t(`calendar.makeup.source.${value}`),
            }))}
            key={form.key('frameSource')}
            {...form.getInputProps('frameSource')}
          />
        </SimpleGrid>
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

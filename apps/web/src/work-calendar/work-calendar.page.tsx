import {
  ActionIcon,
  Button,
  Card,
  Center,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import {
  IconCalendarEvent,
  IconChevronLeft,
  IconChevronRight,
  IconClockHour4,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { z } from 'zod';
import { useSession } from '../auth/session.provider';
import { BusinessDateInput } from '../hr/components/business-date-input.component';
import { MutationError } from '../hr/components/mutation-error.component';
import { QueryState } from '../hr/components/query-state.component';
import { useHrMe, useHrServices } from '../hr/hr-services.provider';
import { formatDate } from '../i18n/format.helper';
import { isMessageKey, type Locale } from '../i18n/i18n.helper';
import { useI18n } from '../i18n/i18n.provider';

/** Day of week of a `YYYY-MM-DD` business date, computed in UTC so no viewer timezone shifts it. */
const utcDate = (date: string) => {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

const isWeekday = (date: string) => ![0, 6].includes(utcDate(date).getUTCDay());

const weekdayName = (date: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(utcDate(date));

/** The business year now (ADR 0018: Asia/Ho_Chi_Minh), unless the URL names a valid one. */
function selectedYear(param: string | null): number {
  const year = param && /^\d{4}$/.test(param) ? Number(param) : NaN;
  if (year >= 1900 && year <= 2100) return year;
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric' }).format(
      new Date(),
    ),
  );
}

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

function useCalendarRefresh() {
  const { namespace } = useSession();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [namespace, 'workCalendar'] });
}

function HolidayForm(props: { readonly expectedVersion: string; readonly onClose: () => void }) {
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

/**
 * Work calendar (T4): the standard week and the paid holidays of one year (`?year=`). Changes
 * follow the server's company-scope hint; the API decides each one (HR/Admin, fresh session) and
 * refuses a change made on an older calendar version (409).
 */
export function WorkCalendarPage() {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { workCalendar } = useHrServices();
  const me = useHrMe();
  const refresh = useCalendarRefresh();
  const [params, setParams] = useSearchParams();
  const [adding, add] = useDisclosure();
  const year = selectedYear(params.get('year'));
  const calendar = useQuery({
    queryKey: [namespace, 'workCalendar', year],
    queryFn: ({ signal }) => workCalendar.year(year, signal),
  });
  const remove = useMutation({
    mutationFn: (input: { date: string; expectedVersion: string }) =>
      workCalendar.setDay(input.date, { expectedVersion: input.expectedVersion, holiday: null }),
    onSuccess: refresh,
  });
  const canManage = me.data?.companyScope === true;
  const go = (next: number) => setParams(new URLSearchParams({ year: String(next) }));

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('calendar.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('calendar.description')}
        </Text>
      </div>
      <Card padding="lg">
        <Stack gap="xs">
          <Group gap="xs">
            <IconClockHour4 size={20} stroke={1.75} aria-hidden />
            <Title order={2}>{t('calendar.standard.title')}</Title>
          </Group>
          <Text>{t('calendar.standard.days')}</Text>
          <Text size="sm" c="dimmed">
            {t('calendar.standard.rest')}
          </Text>
        </Stack>
      </Card>
      <Card padding="lg">
        <Stack gap="md">
          <Group justify="space-between" wrap="wrap">
            <Group gap="xs">
              <IconCalendarEvent size={20} stroke={1.75} aria-hidden />
              <Title order={2}>{t('calendar.holidays.title')}</Title>
            </Group>
            <Group gap="xs">
              <ActionIcon
                variant="default"
                size="lg"
                aria-label={t('calendar.year.previous')}
                disabled={year <= 1900}
                onClick={() => go(year - 1)}
              >
                <IconChevronLeft size={18} stroke={1.75} aria-hidden />
              </ActionIcon>
              <Text fw={600} miw={48} ta="center">
                {year}
              </Text>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label={t('calendar.year.next')}
                disabled={year >= 2100}
                onClick={() => go(year + 1)}
              >
                <IconChevronRight size={18} stroke={1.75} aria-hidden />
              </ActionIcon>
              {canManage && calendar.data && (
                <Button
                  variant="light"
                  leftSection={<IconPlus size={18} stroke={1.75} aria-hidden />}
                  onClick={add.open}
                >
                  {t('calendar.holidays.add')}
                </Button>
              )}
            </Group>
          </Group>
          <MutationError error={remove.error} />
          <QueryState
            pending={calendar.isPending}
            error={calendar.error}
            onRetry={() => calendar.refetch()}
          >
            {calendar.data?.holidays.length === 0 ? (
              <Center py="xl">
                <Stack align="center" gap="xs">
                  <ThemeIcon size={44} radius="md" variant="light" color="gray" aria-hidden>
                    <IconCalendarEvent size={24} stroke={1.75} />
                  </ThemeIcon>
                  <Text c="dimmed">{t('calendar.holidays.empty')}</Text>
                </Stack>
              </Center>
            ) : (
              <Table.ScrollContainer minWidth={420}>
                <Table verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('calendar.holidays.date')}</Table.Th>
                      <Table.Th>{t('calendar.holidays.weekday')}</Table.Th>
                      <Table.Th>{t('calendar.holidays.name')}</Table.Th>
                      {canManage && <Table.Th>{t('common.actions')}</Table.Th>}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {calendar.data?.holidays.map((holiday) => (
                      <Table.Tr key={holiday.date}>
                        <Table.Td>{formatDate(holiday.date)}</Table.Td>
                        <Table.Td>{weekdayName(holiday.date, locale)}</Table.Td>
                        <Table.Td>{holiday.name}</Table.Td>
                        {canManage && (
                          <Table.Td>
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              size="lg"
                              aria-label={`${t('calendar.holidays.remove')} ${formatDate(holiday.date)}`}
                              loading={remove.isPending && remove.variables?.date === holiday.date}
                              disabled={remove.isPending}
                              onClick={() =>
                                calendar.data &&
                                remove.mutate({
                                  date: holiday.date,
                                  expectedVersion: calendar.data.version,
                                })
                              }
                            >
                              <IconTrash size={18} stroke={1.75} aria-hidden />
                            </ActionIcon>
                          </Table.Td>
                        )}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
            {calendar.data && (
              <Text size="xs" c="dimmed">
                {t('calendar.version')}: {calendar.data.version}
              </Text>
            )}
          </QueryState>
        </Stack>
      </Card>
      {calendar.data && (
        <Modal opened={adding} onClose={add.close} title={t('calendar.holidays.add')}>
          <HolidayForm expectedVersion={calendar.data.version} onClose={add.close} />
        </Modal>
      )}
    </Stack>
  );
}

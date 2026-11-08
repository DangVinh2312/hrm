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
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconBriefcase,
  IconCalendarEvent,
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useSearchParams } from 'react-router';
import { useSession } from '../auth/session.provider';
import { MutationError } from '../account/components/mutation-error.component';
import { QueryState } from '../../components/query-state.component';
import { useWorkCalendarClient } from './work-calendar-services.provider';
import { formatDate } from '../../i18n/format.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { HolidayForm, MakeupForm } from './components/calendar-forms.component';
import { CompanyScheduleSection } from './components/company-schedule.component';
import { isoWeekdayName } from '../../components/week-frames.helper';
import {
  refreshOnConflict,
  selectedYear,
  useCalendarRefresh,
  weekdayName,
} from './work-calendar.helper';
import { useOwnEmployee } from '../employee/employee-services.provider';

/**
 * Work calendar (T4, ADR-19): the company week, the paid holidays and the makeup days of one
 * year (`?year=`). Changes
 * follow the server's company-scope hint; the API decides each one (HR/Admin, fresh session) and
 * refuses a change made on an older calendar version (409).
 */
type RemovedDay = { date: string; expectedVersion: string; makeup: boolean };

export function WorkCalendarPage() {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const workCalendar = useWorkCalendarClient();
  const me = useOwnEmployee();
  const refresh = useCalendarRefresh();
  const [params, setParams] = useSearchParams();
  const [adding, add] = useDisclosure();
  const [addingMakeup, addMakeup] = useDisclosure();
  const holidaysTitle = useId();
  const makeupTitle = useId();
  const year = selectedYear(params.get('year'));
  const calendar = useQuery({
    queryKey: [namespace, 'workCalendar', year],
    queryFn: ({ signal }) => workCalendar.year(year, signal),
  });
  // A holiday goes back to a workday, a makeup day back to a day off.
  const remove = useMutation({
    mutationFn: ({ date, expectedVersion, makeup }: RemovedDay) =>
      workCalendar.setDay(
        date,
        makeup ? { expectedVersion, makeup: null } : { expectedVersion, holiday: null },
      ),
    onSuccess: refresh,
    onError: (error) => refreshOnConflict(error, refresh),
  });
  const removeButton = (date: string, label: string, makeup: boolean) => (
    <ActionIcon
      variant="subtle"
      color="red"
      size="lg"
      aria-label={`${label} ${formatDate(date)}`}
      loading={remove.isPending && remove.variables?.date === date}
      disabled={remove.isPending}
      onClick={() =>
        calendar.data && remove.mutate({ date, expectedVersion: calendar.data.version, makeup })
      }
    >
      <IconTrash size={18} stroke={1.75} aria-hidden />
    </ActionIcon>
  );
  const canManage = me.data?.companyScope === true;
  const go = (next: number) => setParams(new URLSearchParams({ year: String(next) }));

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <div>
          <Title order={1}>{t('calendar.title')}</Title>
          <Text c="dimmed" mt={4}>
            {t('calendar.description')}
          </Text>
        </div>
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
        </Group>
      </Group>
      <CompanyScheduleSection canManage={canManage} />
      <MutationError error={remove.error} />
      <QueryState
        pending={calendar.isPending}
        error={calendar.error}
        onRetry={() => calendar.refetch()}
      >
        <Card padding="lg" component="section" aria-labelledby={holidaysTitle}>
          <Stack gap="md">
            <Group justify="space-between" wrap="wrap">
              <Group gap="xs">
                <IconCalendarEvent size={20} stroke={1.75} aria-hidden />
                <Title order={2} id={holidaysTitle}>
                  {t('calendar.holidays.title')}
                </Title>
              </Group>
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
                            {removeButton(holiday.date, t('calendar.holidays.remove'), false)}
                          </Table.Td>
                        )}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Stack>
        </Card>
        <Card padding="lg" component="section" aria-labelledby={makeupTitle}>
          <Stack gap="md">
            <Group justify="space-between" wrap="wrap">
              <Group gap="xs">
                <IconBriefcase size={20} stroke={1.75} aria-hidden />
                <Title order={2} id={makeupTitle}>
                  {t('calendar.makeup.title')}
                </Title>
              </Group>
              {canManage && calendar.data && (
                <Button
                  variant="light"
                  leftSection={<IconPlus size={18} stroke={1.75} aria-hidden />}
                  onClick={addMakeup.open}
                >
                  {t('calendar.makeup.add')}
                </Button>
              )}
            </Group>
            <Text size="sm" c="dimmed">
              {t('calendar.makeup.description')}
            </Text>
            {calendar.data?.makeupDays.length === 0 ? (
              <Center py="xl">
                <Stack align="center" gap="xs">
                  <ThemeIcon size={44} radius="md" variant="light" color="gray" aria-hidden>
                    <IconBriefcase size={24} stroke={1.75} />
                  </ThemeIcon>
                  <Text c="dimmed">{t('calendar.makeup.empty')}</Text>
                </Stack>
              </Center>
            ) : (
              <Table.ScrollContainer minWidth={420}>
                <Table verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('calendar.holidays.date')}</Table.Th>
                      <Table.Th>{t('calendar.holidays.weekday')}</Table.Th>
                      <Table.Th>{t('calendar.makeup.hours')}</Table.Th>
                      {canManage && <Table.Th>{t('common.actions')}</Table.Th>}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {calendar.data?.makeupDays.map((day) => (
                      <Table.Tr key={day.date}>
                        <Table.Td>{formatDate(day.date)}</Table.Td>
                        <Table.Td>{weekdayName(day.date, locale)}</Table.Td>
                        <Table.Td>
                          {t('calendar.makeup.as')} {isoWeekdayName(day.asWeekday, locale)} ·{' '}
                          {t(`calendar.makeup.source.${day.frameSource}`)}
                        </Table.Td>
                        {canManage && (
                          <Table.Td>
                            {removeButton(day.date, t('calendar.makeup.remove'), true)}
                          </Table.Td>
                        )}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Stack>
        </Card>
        {calendar.data && (
          <Text size="xs" c="dimmed">
            {t('calendar.version')}: {calendar.data.version}
          </Text>
        )}
      </QueryState>
      {calendar.data && (
        <>
          <Modal opened={adding} onClose={add.close} title={t('calendar.holidays.add')}>
            <HolidayForm expectedVersion={calendar.data.version} onClose={add.close} />
          </Modal>
          <Modal opened={addingMakeup} onClose={addMakeup.close} title={t('calendar.makeup.add')}>
            <MakeupForm expectedVersion={calendar.data.version} onClose={addMakeup.close} />
          </Modal>
        </>
      )}
    </Stack>
  );
}

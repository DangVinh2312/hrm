import {
  Alert,
  Badge,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { z } from 'zod';
import { useSession } from '../auth/session.provider';
import { QueryState } from '../hr/components/query-state.component';
import { useHrMe, useHrServices } from '../hr/hr-services.provider';
import { formatDays } from '../i18n/format.helper';
import type { Locale, MessageKey } from '../i18n/i18n.helper';
import { useI18n } from '../i18n/i18n.provider';
import { AttendancePeriodPanel } from './attendance-period.component';
import type { AttendanceSheet } from './attendance.client';

/** The month in the URL (not sensitive); anything but `YYYY-MM` means "this month". */
const monthFrom = (params: URLSearchParams): string | null => {
  const parsed = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .safeParse(params.get('month'));
  return parsed.success ? parsed.data : null;
};

type Translate = (key: MessageKey) => string;

interface Figure {
  readonly label: MessageKey;
  readonly hint: MessageKey;
  readonly value: (sheet: AttendanceSheet, t: Translate, locale: Locale) => string;
  /** The same figure in minutes, shown beneath it. */
  readonly detail: (sheet: AttendanceSheet, t: Translate) => string;
}

const days = (minutes: number, t: Translate, locale: Locale) =>
  `${formatDays(minutes, locale)} ${t('attendance.unitDay')}`;
const inMinutes = (minutes: number, t: Translate) => `${minutes} ${t('attendance.unitMinute')}`;
const counted = (count: number, minutes: number, t: Translate) =>
  `${count} ${t('attendance.unitTimes')} · ${inMinutes(minutes, t)}`;

const figures: readonly Figure[] = [
  {
    label: 'attendance.scheduled',
    hint: 'attendance.scheduledHint',
    value: (s, t, l) => days(s.scheduledMinutes, t, l),
    detail: (s, t) => inMinutes(s.scheduledMinutes, t),
  },
  {
    label: 'attendance.paid',
    hint: 'attendance.paidHint',
    value: (s, t, l) => days(s.paidMinutes, t, l),
    detail: (s, t) => inMinutes(s.paidMinutes, t),
  },
  {
    label: 'attendance.holiday',
    hint: 'attendance.holidayHint',
    value: (s, t, l) => days(s.paidHolidayMinutes, t, l),
    detail: (s, t) => inMinutes(s.paidHolidayMinutes, t),
  },
  {
    label: 'attendance.unpaid',
    hint: 'attendance.unpaidHint',
    value: (s, t, l) => days(s.unpaidMinutes, t, l),
    detail: (s, t) => inMinutes(s.unpaidMinutes, t),
  },
  {
    label: 'attendance.annual',
    hint: 'attendance.annualHint',
    value: (s, t, l) => days(s.annualLeaveMinutes, t, l),
    detail: (s, t) => inMinutes(s.annualLeaveMinutes, t),
  },
  {
    label: 'attendance.wfh',
    hint: 'attendance.wfhHint',
    value: (s, t) => `${s.wfhDays} ${t('attendance.unitDay')}`,
    detail: () => '',
  },
  {
    label: 'attendance.late',
    hint: 'attendance.lateHint',
    value: (s, t) => counted(s.lateCount, s.lateMinutes, t),
    detail: () => '',
  },
  {
    label: 'attendance.early',
    hint: 'attendance.earlyHint',
    value: (s, t) => counted(s.earlyCount, s.earlyMinutes, t),
    detail: () => '',
  },
];

/** The signed-in employee's own monthly attendance sheet (T8, D05), computed by the API. */
export function AttendancePage() {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { attendance } = useHrServices();
  const me = useHrMe();
  const [params, setParams] = useSearchParams();
  const month = monthFrom(params);
  const employeeId = me.data?.employee?.id;
  const sheet = useQuery({
    queryKey: [namespace, 'attendance', 'sheet', employeeId ?? null, month],
    enabled: employeeId !== undefined,
    queryFn: ({ signal }) =>
      employeeId === undefined
        ? Promise.reject(new Error('No own profile'))
        : attendance.sheet(employeeId, month, signal),
  });

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('attendance.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('attendance.description')}
        </Text>
      </div>
      <Card padding="lg">
        <QueryState pending={me.isPending} error={me.error} onRetry={() => me.refetch()}>
          {employeeId === undefined ? (
            <Alert
              color="gray"
              title={t('notFound.title')}
              icon={<IconAlertCircle size={18} aria-hidden />}
            >
              {t('notFound.body')}
            </Alert>
          ) : (
            <Stack gap="lg">
              <TextInput
                type="month"
                label={t('attendance.month')}
                description={t('attendance.monthHint')}
                value={month ?? sheet.data?.month ?? ''}
                min="1900-01"
                max="2100-12"
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setParams(/^\d{4}-(0[1-9]|1[0-2])$/.test(next) ? { month: next } : {});
                }}
                maw={240}
              />
              <QueryState
                pending={sheet.isPending}
                error={sheet.error}
                onRetry={() => sheet.refetch()}
              >
                {sheet.data && (
                  <Stack gap="md">
                    <Group gap="xs">
                      <Text fw={600}>{t('attendance.periodState')}</Text>
                      <Badge
                        color={sheet.data.periodState === 'closed' ? 'gray' : 'green'}
                        variant="light"
                      >
                        {t(
                          sheet.data.periodState === 'closed'
                            ? 'attendance.state.closed'
                            : 'attendance.state.open',
                        )}
                      </Badge>
                    </Group>
                    <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
                      {figures.map((figure) => (
                        <Card
                          key={figure.label}
                          component="section"
                          aria-label={t(figure.label)}
                          withBorder
                          padding="md"
                        >
                          <Text size="sm" fw={500}>
                            {t(figure.label)}
                          </Text>
                          <Text fz={22} fw={600} lh={1.3}>
                            {figure.value(sheet.data, t, locale)}
                          </Text>
                          {figure.detail(sheet.data, t) !== '' && (
                            <Text size="xs" c="dimmed">
                              {figure.detail(sheet.data, t)}
                            </Text>
                          )}
                          <Text size="xs" c="dimmed">
                            {t(figure.hint)}
                          </Text>
                        </Card>
                      ))}
                    </SimpleGrid>
                  </Stack>
                )}
              </QueryState>
            </Stack>
          )}
        </QueryState>
      </Card>
      {me.data?.companyScope === true && <AttendancePeriodPanel />}
    </Stack>
  );
}

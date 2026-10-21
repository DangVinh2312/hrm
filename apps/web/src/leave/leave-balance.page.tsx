import { Alert, Card, Group, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { z } from 'zod';
import { useSession } from '../auth/session.provider';
import { QueryState } from '../hr/components/query-state.component';
import { useHrMe, useHrServices } from '../hr/hr-services.provider';
import { formatDate, formatDays } from '../i18n/format.helper';
import type { MessageKey } from '../i18n/i18n.helper';
import { useI18n } from '../i18n/i18n.provider';
import { LeaveReconciliation } from './leave-reconciliation.component';
import type { LeaveBalance } from './leave.client';

/** The report date in the URL (not sensitive); anything but a real date means "today". */
const dateFrom = (params: URLSearchParams): string | null => {
  const parsed = z.iso.date().safeParse(params.get('date'));
  return parsed.success ? parsed.data : null;
};

const figures: readonly {
  readonly label: MessageKey;
  readonly hint: MessageKey;
  readonly value: (balance: LeaveBalance) => number;
}[] = [
  { label: 'leave.entitled', hint: 'leave.entitledHint', value: (b) => b.entitledMinutes },
  { label: 'leave.used', hint: 'leave.usedHint', value: (b) => b.usedMinutes },
  { label: 'leave.future', hint: 'leave.futureHint', value: (b) => b.futureApprovedMinutes },
  { label: 'leave.pending', hint: 'leave.pendingHint', value: (b) => b.pendingMinutes },
  { label: 'leave.available', hint: 'leave.availableHint', value: (b) => b.availableMinutes },
];

/** The signed-in employee's own annual leave balance at a report date (D09), minutes as days. */
export function LeaveBalancePage() {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { leave } = useHrServices();
  const me = useHrMe();
  const [params, setParams] = useSearchParams();
  const date = dateFrom(params);
  const employeeId = me.data?.employee?.id;
  const balance = useQuery({
    queryKey: [namespace, 'leave', 'balance', employeeId ?? null, date],
    enabled: employeeId !== undefined,
    queryFn: ({ signal }) =>
      employeeId === undefined
        ? Promise.reject(new Error('No own profile'))
        : leave.balance(employeeId, date, signal),
  });

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('leave.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('leave.description')}
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
                type="date"
                label={t('leave.date')}
                description={t('leave.dateHint')}
                value={date ?? ''}
                min="1900-01-01"
                max="2100-12-31"
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setParams(z.iso.date().safeParse(next).success ? { date: next } : {});
                }}
                maw={240}
              />
              <QueryState
                pending={balance.isPending}
                error={balance.error}
                onRetry={() => balance.refetch()}
              >
                {balance.data && (
                  <Stack gap="md">
                    <Group gap="xs">
                      <Text fw={600}>{t('leave.annualRate')}</Text>
                      <Text>
                        {balance.data.annualMinutes === null
                          ? '—'
                          : `${formatDays(balance.data.annualMinutes, locale)} ${t('leave.unit')}`}
                      </Text>
                      <Text c="dimmed" size="sm">
                        {`${t('leave.asOn')} ${formatDate(balance.data.asOn)}`}
                      </Text>
                    </Group>
                    <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
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
                          <Text fz={28} fw={600} lh={1.3}>
                            {`${formatDays(figure.value(balance.data), locale)} ${t('leave.unit')}`}
                          </Text>
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
      {me.data?.companyScope === true && <LeaveReconciliation />}
    </Stack>
  );
}

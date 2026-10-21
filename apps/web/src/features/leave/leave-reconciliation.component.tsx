import {
  Anchor,
  Card,
  Group,
  NumberInput,
  Pagination,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../auth/session.provider';
import { QueryState } from '../hr/components/query-state.component';
import { useHrServices } from '../hr/hr-services.provider';
import { formatDays } from '../../i18n/format.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { RECONCILIATION_PAGE_SIZE } from './leave.client';

/**
 * HR view of pending annual leave that already exceeds the accrual (E-17). Read only on purpose:
 * keeping, telling or having a request cancelled is HR's decision, made on the request itself.
 */
export function LeaveReconciliation() {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { leave } = useHrServices();
  const title = useId();
  const [year, setYear] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: [namespace, 'leave', 'reconciliation', year, page],
    queryFn: ({ signal }) => leave.reconciliation({ year, page }, signal),
    placeholderData: keepPreviousData,
  });
  const days = (minutes: number) => `${formatDays(minutes, locale)} ${t('leave.unit')}`;
  const pages = Math.max(1, Math.ceil(Number(list.data?.total ?? '0') / RECONCILIATION_PAGE_SIZE));
  return (
    <Card padding="lg" component="section" aria-labelledby={title}>
      <Stack gap="md">
        <div>
          <Title order={2} id={title}>
            {t('leave.reconciliation.title')}
          </Title>
          <Text size="sm" c="dimmed" mt={4}>
            {t('leave.reconciliation.description')}
          </Text>
        </div>
        <NumberInput
          label={t('leave.reconciliation.year')}
          placeholder={list.data ? String(list.data.year) : ''}
          min={1900}
          max={2100}
          allowDecimal={false}
          allowNegative={false}
          value={year ?? ''}
          onChange={(value) => {
            setYear(typeof value === 'number' && value >= 1900 && value <= 2100 ? value : null);
            setPage(1);
          }}
          maw={160}
        />
        <QueryState pending={list.isPending} error={list.error} onRetry={() => list.refetch()}>
          {list.data?.items.length === 0 ? (
            <Text c="dimmed">{t('leave.reconciliation.empty')}</Text>
          ) : (
            <Table.ScrollContainer minWidth={640}>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('leave.reconciliation.employee')}</Table.Th>
                    <Table.Th>{t('leave.reconciliation.month')}</Table.Th>
                    <Table.Th>{t('leave.reconciliation.accrued')}</Table.Th>
                    <Table.Th>{t('leave.reconciliation.approved')}</Table.Th>
                    <Table.Th>{t('leave.reconciliation.pending')}</Table.Th>
                    <Table.Th>{t('leave.reconciliation.excess')}</Table.Th>
                    <Table.Th>{t('leave.reconciliation.requests')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.data?.items.map((item) => (
                    <Table.Tr key={`${item.employeeId}-${item.month}`}>
                      <Table.Td>
                        <Text span fw={600}>
                          {item.employeeCode}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {item.employeeName}
                        </Text>
                      </Table.Td>
                      <Table.Td>{item.month}</Table.Td>
                      <Table.Td>{days(item.accruedMinutes)}</Table.Td>
                      <Table.Td>{days(item.approvedMinutes)}</Table.Td>
                      <Table.Td>{days(item.pendingMinutes)}</Table.Td>
                      <Table.Td>{days(item.excessMinutes)}</Table.Td>
                      <Table.Td>
                        <Group gap="xs">
                          {item.requestIds.map((id) => (
                            <Anchor key={id} component={Link} to={`/requests/${id}`} size="sm">
                              {id.slice(0, 8)}
                            </Anchor>
                          ))}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          {pages > 1 && <Pagination total={pages} value={page} onChange={setPage} />}
        </QueryState>
      </Stack>
    </Card>
  );
}

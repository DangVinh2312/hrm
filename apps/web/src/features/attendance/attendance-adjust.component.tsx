import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertCircle, IconPlus } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../auth/session.provider';
import { QueryState } from '../hr/components/query-state.component';
import { useHrMe, useHrServices } from '../hr/hr-services.provider';
import { formatDate, formatDateTime } from '../../i18n/format.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { AttendanceAdjustForm } from './attendance-adjust-form.component';
import { currentMonth, monthPattern } from './attendance.helper';
import { useState } from 'react';

/**
 * HR's audited adjustments of one employee's paid minutes (`attendance.adjust`, user decision
 * 2026-10-22): a month picker, the entries of the month with their reasons, and a form to add one
 * (a signed number of minutes for one day, mandatory reason, optional reference). Entries are
 * never edited or deleted: a mistake is corrected by an entry of the opposite sign. A closed month
 * shows the state and disables the button, but the API decides (409 `error.periodClosed`).
 */
export function AttendanceAdjustSection(props: { readonly employeeId: string }) {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { attendance } = useHrServices();
  // Display hint only: the API refuses (403) whoever adjusts the employee linked to their own account.
  const own = useHrMe().data?.employee?.id === props.employeeId;
  const [month, setMonth] = useState(currentMonth);
  const [adding, dialog] = useDisclosure();
  const valid = monthPattern.test(month);
  const list = useQuery({
    queryKey: [namespace, 'attendance', 'adjustments', props.employeeId, month],
    enabled: valid,
    queryFn: ({ signal }) => attendance.adjustments(props.employeeId, month, signal),
  });
  const closed = list.data?.periodState === 'closed';
  return (
    <Card padding="lg">
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Title order={2}>{t('attendance.adjust.title')}</Title>
          <Button
            variant="light"
            leftSection={<IconPlus size={18} stroke={1.75} aria-hidden />}
            disabled={!valid || closed || own || list.data === undefined}
            onClick={dialog.open}
          >
            {t('attendance.adjust.add')}
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          {t('attendance.adjust.description')}
        </Text>
        {own && <Text size="sm">{t('attendance.adjust.selfHint')}</Text>}
        <TextInput
          type="month"
          label={t('attendance.adjust.month')}
          value={month}
          min="1900-01"
          max="2100-12"
          onChange={(event) => setMonth(event.currentTarget.value)}
          maw={240}
        />
        {valid && (
          <QueryState pending={list.isPending} error={list.error} onRetry={() => list.refetch()}>
            {list.data && (
              <Stack gap="md">
                <Group gap="sm">
                  <Badge color={closed ? 'gray' : 'green'} variant="light">
                    {t(closed ? 'attendance.state.closed' : 'attendance.state.open')}
                  </Badge>
                  <Text size="sm">
                    {t('attendance.adjust.total')}: {list.data.adjustmentMinutes}{' '}
                    {t('attendance.unitMinute')}
                  </Text>
                </Group>
                {closed && (
                  <Alert color="gray" icon={<IconAlertCircle size={18} aria-hidden />}>
                    {t('attendance.adjust.closedHint')}
                  </Alert>
                )}
                {list.data.items.length === 0 ? (
                  <Text c="dimmed">{t('attendance.adjust.empty')}</Text>
                ) : (
                  <Table.ScrollContainer minWidth={520}>
                    <Table verticalSpacing="xs" aria-label={t('attendance.adjust.history')}>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{t('attendance.adjust.date')}</Table.Th>
                          <Table.Th>{t('attendance.adjust.minutes')}</Table.Th>
                          <Table.Th>{t('attendance.adjust.reason')}</Table.Th>
                          <Table.Th>{t('attendance.adjust.reference')}</Table.Th>
                          <Table.Th>{t('attendance.adjust.createdAt')}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {list.data.items.map((item) => (
                          <Table.Tr key={item.id}>
                            <Table.Td>{formatDate(item.workDate)}</Table.Td>
                            <Table.Td>
                              {item.minutes > 0 ? `+${item.minutes}` : item.minutes}
                            </Table.Td>
                            <Table.Td>{item.reason}</Table.Td>
                            <Table.Td>{item.reference ?? '—'}</Table.Td>
                            <Table.Td>{formatDateTime(item.createdAt, locale)}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                )}
              </Stack>
            )}
          </QueryState>
        )}
      </Stack>
      <Modal opened={adding} onClose={dialog.close} title={t('attendance.adjust.add')}>
        <AttendanceAdjustForm employeeId={props.employeeId} month={month} onClose={dialog.close} />
      </Modal>
    </Card>
  );
}

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
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertCircle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '../auth/session.provider';
import { MutationError } from '../hr/components/mutation-error.component';
import { ApiError } from '../../infrastructure/http.client';
import { QueryState } from '../hr/components/query-state.component';
import { useHrServices } from '../hr/hr-services.provider';
import { formatDateTime } from '../../i18n/format.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { currentMonth, monthPattern } from './attendance.helper';

/**
 * HR close/reopen of an attendance month (D07). Shown on the company-scope hint; the API decides
 * (fresh session, 409 when already in that state or in the future), and the history it returns —
 * who is not shown, when and why is — is the audit trail HR reads before reopening.
 */
export function AttendancePeriodPanel() {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { attendance } = useHrServices();
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(currentMonth);
  const [closing, closeDialog] = useDisclosure();
  const [reopening, reopenDialog] = useDisclosure();
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const valid = monthPattern.test(month);
  const period = useQuery({
    queryKey: [namespace, 'attendance', 'period', month],
    enabled: valid,
    queryFn: ({ signal }) => attendance.period(month, signal),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: [namespace, 'attendance'] });
  // 409 on close/reopen: the month is already in that state, or has not started yet; the panel
  // says so and reloads the state it shows (no new error key: the HTTP code is all it knows).
  function reloadOnConflict(error: unknown) {
    if (error instanceof ApiError && error.status === 409 && error.code !== 'error.periodClosed')
      void refresh();
  }
  const close = useMutation({
    mutationFn: () => attendance.closePeriod(month),
    onSuccess: async () => {
      closeDialog.close();
      await refresh();
    },
    onError: reloadOnConflict,
  });
  const reopen = useMutation({
    mutationFn: (text: string) => attendance.reopenPeriod(month, text),
    onSuccess: async () => {
      reopenDialog.close();
      setReason('');
      await refresh();
    },
    onError: reloadOnConflict,
  });
  const state = period.data?.state;
  const confirmReopen = () => {
    const text = reason.trim();
    setReasonMissing(text === '');
    if (text !== '') reopen.mutate(text);
  };
  return (
    <Card padding="lg">
      <Stack gap="md">
        <Title order={2}>{t('attendance.period.title')}</Title>
        <Text size="sm" c="dimmed">
          {t('attendance.period.description')}
        </Text>
        <TextInput
          type="month"
          label={t('attendance.period.month')}
          value={month}
          min="1900-01"
          max="2100-12"
          onChange={(event) => setMonth(event.currentTarget.value)}
          maw={240}
        />
        {valid && (
          <QueryState
            pending={period.isPending}
            error={period.error}
            onRetry={() => period.refetch()}
          >
            {period.data && (
              <Stack gap="md">
                <Group gap="sm">
                  <Badge color={state === 'closed' ? 'gray' : 'green'} variant="light">
                    {t(state === 'closed' ? 'attendance.state.closed' : 'attendance.state.open')}
                  </Badge>
                  {state === 'open' ? (
                    <Button variant="light" onClick={closeDialog.open}>
                      {t('attendance.period.close')}
                    </Button>
                  ) : (
                    <Button variant="light" onClick={reopenDialog.open}>
                      {t('attendance.period.reopen')}
                    </Button>
                  )}
                </Group>
                {period.data.events.length === 0 ? (
                  <Text c="dimmed">{t('attendance.period.noHistory')}</Text>
                ) : (
                  <Table.ScrollContainer minWidth={420}>
                    <Table verticalSpacing="xs" aria-label={t('attendance.period.history')}>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{t('attendance.period.event')}</Table.Th>
                          <Table.Th>{t('attendance.period.at')}</Table.Th>
                          <Table.Th>{t('attendance.period.reasonColumn')}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {period.data.events.map((event) => (
                          <Table.Tr key={event.version}>
                            <Table.Td>
                              {t(
                                event.event === 'close'
                                  ? 'attendance.period.event.close'
                                  : 'attendance.period.event.reopen',
                              )}
                            </Table.Td>
                            <Table.Td>{formatDateTime(event.occurredAt, locale)}</Table.Td>
                            <Table.Td>{event.reason ?? '—'}</Table.Td>
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
      <Modal opened={closing} onClose={closeDialog.close} title={t('attendance.period.close')}>
        <Stack gap="md">
          <Text size="sm">{t('attendance.period.closeBody')}</Text>
          <PeriodError error={close.error} />
          <Group justify="flex-end">
            <Button variant="default" onClick={closeDialog.close}>
              {t('common.cancel')}
            </Button>
            <Button loading={close.isPending} onClick={() => close.mutate()}>
              {t('attendance.period.closeConfirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={reopening} onClose={reopenDialog.close} title={t('attendance.period.reopen')}>
        <Stack gap="md">
          <Text size="sm">{t('attendance.period.reopenBody')}</Text>
          <PeriodError error={reopen.error} />
          <Textarea
            label={t('attendance.period.reason')}
            withAsterisk
            maxLength={1000}
            rows={3}
            value={reason}
            error={reasonMissing ? t('attendance.period.reasonRequired') : undefined}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={reopenDialog.close}>
              {t('common.cancel')}
            </Button>
            <Button loading={reopen.isPending} onClick={confirmReopen}>
              {t('attendance.period.reopenConfirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}

/** A 409 of the panel's own commands means "state changed or month not closable"; the rest is shared. */
function PeriodError(props: { readonly error: unknown }) {
  const { t } = useI18n();
  if (
    props.error instanceof ApiError &&
    props.error.status === 409 &&
    props.error.code !== 'error.periodClosed'
  )
    return (
      <Alert color="red" icon={<IconAlertCircle size={18} aria-hidden />} role="alert">
        {t('attendance.period.conflict')}
      </Alert>
    );
  return <MutationError error={props.error} />;
}

import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSession } from '../../auth/session.provider';
import { QueryState } from '../../hr/components/query-state.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { formatDate, formatDateTime } from '../../../i18n/format.helper';
import type { MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { ApiError, apiErrorKey } from '../../../infrastructure/http.client';
import { RequestStateBadge } from './request-state-badge.component';
import { type DecisionInput, type RequestState } from '../work-request.client';
import { kindKeys, minuteLabel } from '../work-request.helper';

/**
 * One request and its decision. One idempotency key per distinct decision: a retry after a lost
 * connection reuses it, another decision, reason or version gets a new one. A 409 `error.conflict`
 * or a 404 reloads the request and the queues. A 409 with its own key says what to do: a closed
 * month (`error.periodClosed`) cannot be changed, and `error.wfhLimitAckRequired` (D04: the approval
 * takes the month past 4 WFH days) shows the acknowledgement the approver must tick before
 * approving again; nothing else is read from the error.
 */
export function DecisionDialog(props: {
  readonly requestId: string;
  readonly onClose: () => void;
  readonly onDone: (state: RequestState) => void;
}) {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { workRequest, employees } = useHrServices();
  const queryClient = useQueryClient();
  const attempt = useRef<{ readonly body: string; readonly key: string } | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [failure, setFailure] = useState<MessageKey | undefined>(undefined);
  const [ackNeeded, setAckNeeded] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const request = useQuery({
    queryKey: [namespace, 'requests', 'detail', props.requestId],
    queryFn: ({ signal }) => workRequest.detail(props.requestId, signal),
  });
  const data = request.data;
  // The name is shown when the caller may read the profile; the decision does not depend on it.
  const employee = useQuery({
    queryKey: [namespace, 'employees', 'detail', data?.employeeId],
    queryFn: ({ signal }) => employees.detail(data?.employeeId ?? '', signal),
    enabled: data !== undefined,
  });
  const decide = useMutation({
    mutationFn: (input: DecisionInput) => {
      const body = JSON.stringify([props.requestId, input]);
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      return workRequest.decide(props.requestId, input, attempt.current.key);
    },
    onMutate: () => setFailure(undefined),
    onSuccess: async (result) => {
      attempt.current = undefined;
      await queryClient.invalidateQueries({ queryKey: [namespace, 'approvals'] });
      await queryClient.invalidateQueries({ queryKey: [namespace, 'requests'] });
      props.onDone(result.state);
    },
    onError: async (error) => {
      if (!(error instanceof ApiError)) return setFailure('approval.decision.unknown');
      if (error.code === 'error.wfhLimitAckRequired') {
        setAckNeeded(true);
        return setFailure(error.code);
      }
      if (error.code === 'error.periodClosed') return setFailure(error.code);
      if (error.status !== 409 && error.status !== 404) return setFailure(apiErrorKey(error));
      await queryClient.invalidateQueries({ queryKey: [namespace, 'approvals'] });
      await request.refetch();
      setFailure(error.status === 404 ? apiErrorKey(error) : 'approval.decision.conflict');
    },
  });
  // Reloaded after a conflict or opened late: a decided request cannot be sent again.
  const pending = data?.state === 'pending_lead' || data?.state === 'pending_final';
  const send = (decision: DecisionInput['decision']) => {
    if (!data || !pending) return;
    const text = reason.trim();
    setReasonError(decision === 'reject' && text === '');
    if (decision === 'reject' && text === '') return;
    decide.mutate({
      expectedVersion: data.version,
      decision,
      reason: text === '' ? null : text,
      ...(decision === 'approve' && ackNeeded && acknowledged ? { acknowledgeWfhLimit: true } : {}),
    });
  };

  return (
    <Modal opened onClose={props.onClose} title={t('approval.dialog.title')} size="lg">
      <QueryState
        pending={request.isPending}
        error={request.error}
        onRetry={() => request.refetch()}
      >
        {data && (
          <Stack gap="md">
            {failure && (
              <Alert
                color="red"
                title={t('approval.decision.failedTitle')}
                icon={<IconAlertCircle size={18} aria-hidden />}
                role="alert"
              >
                {t(failure)}
              </Alert>
            )}
            <Group gap="sm">
              <Title order={2}>{t(kindKeys[data.kind])}</Title>
              <RequestStateBadge state={data.state} />
            </Group>
            {employee.data && (
              <Text>
                {t('approval.field.employee')}:{' '}
                <Text span fw={600}>
                  {employee.data.code} · {employee.data.fullName}
                </Text>
              </Text>
            )}
            <Text size="sm" c="dimmed">
              {t('request.field.createdAt')}: {formatDateTime(data.createdAt, locale)}
            </Text>
            <div>
              <Text size="sm" fw={600}>
                {t('request.field.reason')}
              </Text>
              <Text>{data.reason}</Text>
            </div>
            <Table.ScrollContainer minWidth={320}>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('request.field.date')}</Table.Th>
                    <Table.Th>{t('request.field.time')}</Table.Th>
                    <Table.Th>{t('request.field.minutes')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.segments.map((segment) => (
                    <Table.Tr key={segment.date}>
                      <Table.Td>{formatDate(segment.date)}</Table.Td>
                      <Table.Td>
                        {minuteLabel(segment.startMinute)}–{minuteLabel(segment.endMinute)}
                      </Table.Td>
                      <Table.Td>{segment.minutes}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <TextInput
              label={t('approval.decision.note')}
              description={t('approval.decision.noteHint')}
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
              error={reasonError ? t('approval.decision.reasonRequired') : undefined}
            />
            {ackNeeded && (
              <Checkbox
                label={t('approval.wfhAck.label')}
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.currentTarget.checked)}
              />
            )}
            <Group justify="flex-end">
              <Button
                variant="light"
                color="red"
                size="md"
                loading={decide.isPending && decide.variables.decision === 'reject'}
                disabled={decide.isPending || !pending}
                onClick={() => send('reject')}
              >
                {t('approval.decision.reject')}
              </Button>
              <Button
                size="md"
                loading={decide.isPending && decide.variables.decision === 'approve'}
                disabled={decide.isPending || !pending || (ackNeeded && !acknowledged)}
                onClick={() => send('approve')}
              >
                {t('approval.decision.approve')}
              </Button>
            </Group>
          </Stack>
        )}
      </QueryState>
    </Modal>
  );
}

import {
  Alert,
  Anchor,
  Button,
  Card,
  Center,
  Group,
  Modal,
  Pagination,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconAlertCircle, IconChecklist, IconCircleCheck } from '@tabler/icons-react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useSession } from '../../auth/session.provider';
import { QueryState } from '../../hr/components/query-state.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { formatDate, formatDateTime } from '../../i18n/format.helper';
import type { MessageKey } from '../../i18n/i18n.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { ApiError, apiErrorKey } from '../../infrastructure/http.client';
import { RequestStateBadge } from '../components/request-state-badge.component';
import {
  REQUEST_PAGE_SIZE,
  type ApprovalStage,
  type DecisionInput,
  type RequestState,
} from '../work-request.client';
import { approvalIsFinal, kindKeys, minuteLabel, pageFrom } from '../work-request.helper';

const stages: readonly ApprovalStage[] = ['lead', 'final'];
const stageKeys: Readonly<Record<ApprovalStage, MessageKey>> = {
  lead: 'approval.queue.lead',
  final: 'approval.queue.final',
};
const doneKeys: Partial<Record<RequestState, MessageKey>> = {
  pending_final: 'approval.done.forwarded',
  approved: 'approval.done.approved',
  rejected: 'approval.done.rejected',
};

const dates = (start: string, end: string) =>
  start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;

/**
 * Requests waiting for the caller (T6): the lead queue and the final (COO) queue. A stage the
 * caller holds no grant for answers an empty page (its plan reaches nothing), so each queue shows
 * only when something waits in it — the same rule as the `approvals` menu — or when it failed to
 * load (with a retry). A refused queue (403/404) is treated as empty. The stage of a decision
 * follows the stored state on the server; the page sends only the version it showed, the
 * decision and the reason.
 */
export function ApprovalInboxPage() {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { workRequest } = useHrServices();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<MessageKey | undefined>(undefined);
  const requested: ApprovalStage = params.get('queue') === 'final' ? 'final' : 'lead';
  const page = pageFrom(params);
  const queue = (stage: ApprovalStage) => {
    const at = stage === requested ? page : 1;
    return {
      queryKey: [namespace, 'approvals', stage, at],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        workRequest.queue(stage, { page: at }, signal),
      placeholderData: keepPreviousData,
    };
  };
  const queues = { lead: useQuery(queue('lead')), final: useQuery(queue('final')) };
  const visible = stages.filter((value) => {
    const { error, data } = queues[value];
    return error
      ? !(error instanceof ApiError && (error.status === 403 || error.status === 404))
      : Number(data?.total ?? '0') > 0;
  });
  const stage = visible.includes(requested) ? requested : visible[0];
  const current = stage && queues[stage];
  const total = Number(current?.data?.total ?? '0');
  const loading = stages.some((value) => queues[value].isPending);

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('approval.inbox.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('approval.inbox.description')}
        </Text>
      </div>
      {done && (
        <Alert color="green" icon={<IconCircleCheck size={18} aria-hidden />} role="status">
          {t(done)}
        </Alert>
      )}
      {!stage || !current ? (
        <Card padding="lg">
          <QueryState pending={loading} error={undefined} onRetry={() => Promise.resolve()}>
            <Empty />
          </QueryState>
        </Card>
      ) : (
        <Card padding="lg">
          <Tabs
            value={stage}
            onChange={(next) => {
              if (next === 'lead' || next === 'final')
                setParams(new URLSearchParams({ queue: next }));
            }}
          >
            <Tabs.List mb="md">
              {visible.map((value) => (
                <Tabs.Tab key={value} value={value}>
                  {t(stageKeys[value])}
                  {queues[value].data ? ` (${queues[value].data.total})` : ''}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
          <QueryState
            pending={current.isPending}
            error={current.error}
            onRetry={() => current.refetch()}
          >
            <Stack gap="md">
              {current.data?.items.length === 0 ? (
                <Empty />
              ) : (
                <Table.ScrollContainer minWidth={480}>
                  <Table striped highlightOnHover verticalSpacing="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('request.field.kind')}</Table.Th>
                        <Table.Th>{t('request.field.dates')}</Table.Th>
                        <Table.Th>{t('request.field.createdAt')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {current.data?.items.map((item) => (
                        <Table.Tr key={item.id}>
                          <Table.Td>
                            {/* First column: the way in stays visible on a phone (no scroll). */}
                            <Anchor
                              component="button"
                              type="button"
                              fw={500}
                              onClick={() => {
                                setDone(undefined);
                                setOpen(item.id);
                              }}
                            >
                              {t(kindKeys[item.kind])}
                            </Anchor>
                          </Table.Td>
                          <Table.Td>{dates(item.startDate, item.endDate)}</Table.Td>
                          <Table.Td>{formatDateTime(item.createdAt, locale)}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
              {total > REQUEST_PAGE_SIZE && (
                <Group justify="center">
                  <Pagination
                    total={Math.ceil(total / REQUEST_PAGE_SIZE)}
                    value={page}
                    onChange={(next) =>
                      setParams(new URLSearchParams({ queue: stage, page: String(next) }))
                    }
                    getControlProps={(control) => ({
                      'aria-label': t(
                        control === 'next' ? 'common.nextPage' : 'common.previousPage',
                      ),
                    })}
                    withEdges={false}
                  />
                </Group>
              )}
            </Stack>
          </QueryState>
        </Card>
      )}
      {open && (
        <DecisionDialog
          requestId={open}
          onClose={() => setOpen(undefined)}
          onDone={(state) => {
            setOpen(undefined);
            setDone(doneKeys[state]);
          }}
        />
      )}
    </Stack>
  );
}

function Empty() {
  const { t } = useI18n();
  return (
    <Center py="xl">
      <Stack align="center" gap="xs">
        <ThemeIcon size={44} radius="md" variant="light" color="gray" aria-hidden>
          <IconChecklist size={24} stroke={1.75} />
        </ThemeIcon>
        <Text c="dimmed">{t('approval.queue.empty')}</Text>
      </Stack>
    </Center>
  );
}

/**
 * One request and its decision. One idempotency key per distinct decision: a retry after a lost
 * connection reuses it, another decision, reason or version gets a new one. A 409 or 404 reloads
 * the request and the queues; a 409 on an approval that would be final while the version did not
 * move is the closed final step (M3 gate), told apart only for its wording.
 */
function DecisionDialog(props: {
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
    onError: async (error, input) => {
      if (!(error instanceof ApiError)) return setFailure('approval.decision.unknown');
      if (error.status !== 409 && error.status !== 404) return setFailure(apiErrorKey(error));
      await queryClient.invalidateQueries({ queryKey: [namespace, 'approvals'] });
      const fresh = (await request.refetch()).data;
      setFailure(
        error.status === 404
          ? apiErrorKey(error)
          : input.decision === 'approve' &&
              fresh?.version === input.expectedVersion &&
              approvalIsFinal(fresh)
            ? 'approval.decision.finalUnavailable'
            : 'approval.decision.conflict',
      );
    },
  });
  const send = (decision: DecisionInput['decision']) => {
    if (!data) return;
    const text = reason.trim();
    setReasonError(decision === 'reject' && text === '');
    if (decision === 'reject' && text === '') return;
    decide.mutate({ expectedVersion: data.version, decision, reason: text === '' ? null : text });
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
            <Group justify="flex-end">
              <Button
                variant="light"
                color="red"
                size="md"
                loading={decide.isPending && decide.variables.decision === 'reject'}
                disabled={decide.isPending}
                onClick={() => send('reject')}
              >
                {t('approval.decision.reject')}
              </Button>
              <Button
                size="md"
                loading={decide.isPending && decide.variables.decision === 'approve'}
                disabled={decide.isPending}
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

import {
  Alert,
  Anchor,
  Card,
  Center,
  Group,
  Pagination,
  Stack,
  Table,
  Tabs,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconChecklist, IconCircleCheck } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useSession } from '../../auth/session.provider';
import { QueryState } from '../../hr/components/query-state.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { formatDateTime } from '../../../i18n/format.helper';
import type { MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { ApiError } from '../../../infrastructure/http.client';
import { REQUEST_PAGE_SIZE, type ApprovalStage, type RequestState } from '../work-request.client';
import { dateRange, kindKeys, pageFrom } from '../work-request.helper';
import { DecidedTable } from '../components/decided-table.component';
import { DecisionDialog } from '../components/decision-dialog.component';

const stages: readonly ApprovalStage[] = ['lead', 'final'];
type InboxTab = ApprovalStage | 'decided';
const tabKeys: Readonly<Record<InboxTab, MessageKey>> = {
  lead: 'approval.queue.lead',
  final: 'approval.queue.final',
  decided: 'approval.queue.decided',
};
const doneKeys: Partial<Record<RequestState, MessageKey>> = {
  pending_final: 'approval.done.forwarded',
  approved: 'approval.done.approved',
  rejected: 'approval.done.rejected',
};
const tabFrom = (value: string | null): InboxTab =>
  value === 'final' || value === 'decided' ? value : 'lead';

/**
 * Requests waiting for the caller (T6): the lead queue and the final (COO) queue, and the
 * history of requests decided in the caller's approval scope (T6 part C). A stage the caller
 * holds no grant for answers an empty page (its plan reaches nothing), so each queue shows only
 * when something waits in it, or when it failed to load (with a retry); a refused queue (403/404)
 * is treated as empty. The history tab always shows: the page is reached from the `approvals`
 * menu, which follows the approval right, not waiting requests. The stage of a decision follows
 * the stored state on the server; the page sends only the version it showed, the decision and
 * the reason.
 */
export function ApprovalInboxPage() {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { workRequest } = useHrServices();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<MessageKey | undefined>(undefined);
  const requested = tabFrom(params.get('queue'));
  const page = pageFrom(params);
  // The URL's page belongs to the tab it names; any other tab starts at page 1.
  const pageOf = (tab: InboxTab) => (tab === requested ? page : 1);
  const queue = (stage: ApprovalStage) => ({
    queryKey: [namespace, 'approvals', stage, pageOf(stage)],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      workRequest.queue(stage, { page: pageOf(stage) }, signal),
    placeholderData: keepPreviousData,
  });
  const queues = { lead: useQuery(queue('lead')), final: useQuery(queue('final')) };
  const history = useQuery({
    queryKey: [namespace, 'approvals', 'decided', pageOf('decided')],
    queryFn: ({ signal }) => workRequest.decided({ page: pageOf('decided') }, signal),
    placeholderData: keepPreviousData,
  });
  const waiting = stages.filter((value) => {
    const { error, data } = queues[value];
    return error
      ? !(error instanceof ApiError && (error.status === 403 || error.status === 404))
      : Number(data?.total ?? '0') > 0;
  });
  const visible: readonly InboxTab[] = [...waiting, 'decided'];
  const tab = visible.includes(requested) ? requested : (waiting[0] ?? 'decided');
  const current = tab === 'decided' ? history : queues[tab];
  const shown = pageOf(tab);
  const total = Number(current.data?.total ?? '0');
  const loading = stages.some((value) => queues[value].isPending);
  const pages = Math.ceil(total / REQUEST_PAGE_SIZE);
  // Decisions elsewhere emptied this page while others remain: go to the last page.
  const pastEnd = current.data?.items.length === 0 && total > 0 && shown > pages;
  useEffect(() => {
    if (pastEnd)
      setParams(new URLSearchParams({ queue: tab, page: String(pages) }), { replace: true });
  }, [pastEnd, pages, tab, setParams]);

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
      <Card padding="lg">
        <QueryState pending={loading} error={undefined} onRetry={() => Promise.resolve()}>
          <Stack gap="md">
            {waiting.length === 0 && <Text c="dimmed">{t('approval.queue.empty')}</Text>}
            <Tabs
              value={tab}
              onChange={(next) => {
                if (next === 'lead' || next === 'final' || next === 'decided')
                  setParams(new URLSearchParams({ queue: next }));
              }}
            >
              <Tabs.List>
                {visible.map((value) => (
                  <Tabs.Tab key={value} value={value}>
                    {t(tabKeys[value])}
                    {value !== 'decided' && queues[value].data
                      ? ` (${queues[value].data.total})`
                      : ''}
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
                  pastEnd ? null : (
                    <Empty
                      message={
                        tab === 'decided' ? 'approval.history.empty' : 'approval.queue.empty'
                      }
                    />
                  )
                ) : tab === 'decided' ? (
                  <DecidedTable items={history.data?.items ?? []} />
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
                        {queues[tab].data?.items.map((item) => (
                          <Table.Tr key={item.id}>
                            <Table.Td>
                              {/* First column: the way in stays visible on a phone (no scroll). */}
                              <Anchor
                                component="button"
                                type="button"
                                fw={500}
                                aria-label={`${t(kindKeys[item.kind])}, ${dateRange(item.startDate, item.endDate)}`}
                                onClick={() => {
                                  setDone(undefined);
                                  setOpen(item.id);
                                }}
                              >
                                {t(kindKeys[item.kind])}
                              </Anchor>
                            </Table.Td>
                            <Table.Td>{dateRange(item.startDate, item.endDate)}</Table.Td>
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
                      total={pages}
                      value={shown}
                      onChange={(next) =>
                        setParams(new URLSearchParams({ queue: tab, page: String(next) }))
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
          </Stack>
        </QueryState>
      </Card>
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

function Empty(props: { readonly message: MessageKey }) {
  const { t } = useI18n();
  return (
    <Center py="xl">
      <Stack align="center" gap="xs">
        <ThemeIcon size={44} radius="md" variant="light" color="gray" aria-hidden>
          <IconChecklist size={24} stroke={1.75} />
        </ThemeIcon>
        <Text c="dimmed">{t(props.message)}</Text>
      </Stack>
    </Center>
  );
}

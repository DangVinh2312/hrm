import { Alert, Anchor, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { IconAlertCircle, IconArrowLeft } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { useSession } from '../../auth/session.provider';
import { QueryState } from '../../hr/components/query-state.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { formatDate, formatDateTime } from '../../i18n/format.helper';
import type { MessageKey } from '../../i18n/i18n.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { RequestCancel } from '../components/request-cancel.component';
import { RequestStateBadge } from '../components/request-state-badge.component';
import type { RequestDetail } from '../work-request.client';
import { kindKeys, minuteLabel } from '../work-request.helper';

const stageKeys: Readonly<Record<RequestDetail['decisions'][number]['stage'], MessageKey>> = {
  lead: 'request.stage.lead',
  final: 'request.stage.final',
  cancel: 'request.stage.cancel',
};
const decisionKeys: Readonly<Record<RequestDetail['decisions'][number]['decision'], MessageKey>> = {
  approve: 'request.decision.approve',
  reject: 'request.decision.reject',
  skip: 'request.decision.skip',
  cancel: 'request.decision.cancel',
};
const systemReasonKeys = {
  lead_skipped_submitter_is_lead: 'request.systemReason.leadSkipped',
  coo_self_approved: 'request.systemReason.cooSelfApproved',
} as const satisfies Record<string, MessageKey>;

/** One own request: reason, segments and decision history exactly as the API returns them. */
export function RequestDetailPage() {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { workRequest } = useHrServices();
  const id = useParams().id ?? '';
  // Set once by the form after a WFH submit the API warned about (D04); gone on a reload.
  const state: unknown = useLocation().state;
  const warned =
    typeof state === 'object' &&
    state !== null &&
    'wfhLimitExceeded' in state &&
    state.wfhLimitExceeded === true;
  const request = useQuery({
    queryKey: [namespace, 'requests', 'detail', id],
    queryFn: ({ signal }) => workRequest.detail(id, signal),
  });
  const data = request.data;

  return (
    <Stack gap="lg">
      <Anchor component={Link} to="/requests" size="sm">
        <Group gap={4} wrap="nowrap">
          <IconArrowLeft size={16} stroke={1.75} aria-hidden />
          {t('request.detail.back')}
        </Group>
      </Anchor>
      <Title order={1}>{t('request.detail.title')}</Title>
      {warned && (
        <Alert color="yellow" icon={<IconAlertCircle size={18} aria-hidden />} role="status">
          {t('request.wfhLimitWarning')}
        </Alert>
      )}
      <QueryState
        pending={request.isPending}
        error={request.error}
        onRetry={() => request.refetch()}
      >
        {data && (
          <>
            <Card padding="lg">
              <Stack gap="sm">
                <Group gap="sm">
                  <Title order={2}>{t(kindKeys[data.kind])}</Title>
                  <RequestStateBadge state={data.state} />
                </Group>
                <Text size="sm" c="dimmed">
                  {t('request.field.createdAt')}: {formatDateTime(data.createdAt, locale)}
                </Text>
                <div>
                  <Text size="sm" fw={600}>
                    {t('request.field.reason')}
                  </Text>
                  <Text>{data.reason}</Text>
                </div>
                <RequestCancel request={data} />
              </Stack>
            </Card>
            <Card padding="lg">
              <Stack gap="md">
                <Title order={2}>{t('request.detail.segments')}</Title>
                <Table.ScrollContainer minWidth={360}>
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
              </Stack>
            </Card>
            <Card padding="lg">
              <Stack gap="md">
                <Title order={2}>{t('request.detail.history')}</Title>
                {data.decisions.length === 0 ? (
                  <Text c="dimmed">{t('request.detail.noHistory')}</Text>
                ) : (
                  <Table.ScrollContainer minWidth={480}>
                    <Table verticalSpacing="xs">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{t('request.history.stage')}</Table.Th>
                          <Table.Th>{t('request.history.decision')}</Table.Th>
                          <Table.Th>{t('request.history.by')}</Table.Th>
                          <Table.Th>{t('request.history.at')}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {data.decisions.map((decision, index) => (
                          <Table.Tr key={index}>
                            <Table.Td>{t(stageKeys[decision.stage])}</Table.Td>
                            <Table.Td>
                              {t(decisionKeys[decision.decision])}
                              {decision.systemReason && (
                                <Text size="xs" c="dimmed">
                                  {t(systemReasonKeys[decision.systemReason])}
                                </Text>
                              )}
                            </Table.Td>
                            <Table.Td>
                              {t(
                                decision.actorKind === 'system'
                                  ? 'request.actor.system'
                                  : 'request.actor.user',
                              )}
                            </Table.Td>
                            <Table.Td>{formatDateTime(decision.decidedAt, locale)}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                )}
              </Stack>
            </Card>
          </>
        )}
      </QueryState>
    </Stack>
  );
}

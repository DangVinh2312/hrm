import { Table } from '@mantine/core';
import { formatDateTime } from '../../../i18n/format.helper';
import type { MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { RequestStateBadge } from './request-state-badge.component';
import { type DecidedRequestItem } from '../work-request.client';
import { dateRange, kindKeys } from '../work-request.helper';

const decisionKeys: Readonly<Record<`${'lead' | 'final'}.${'approve' | 'reject'}`, MessageKey>> = {
  'lead.approve': 'approval.history.leadApprove',
  'lead.reject': 'approval.history.leadReject',
  'final.approve': 'approval.history.finalApprove',
  'final.reject': 'approval.history.finalReject',
};
const decisionKey = ({ stage, decision, actorKind }: DecidedRequestItem['decision']) =>
  actorKind === 'system' || decision === 'skip'
    ? 'approval.history.system'
    : decisionKeys[`${stage}.${decision}`];

/** Read-only: the history is for reference; the caller may no longer read a request decided by others. */
export function DecidedTable(props: { readonly items: readonly DecidedRequestItem[] }) {
  const { t, locale } = useI18n();
  return (
    <Table.ScrollContainer minWidth={720}>
      <Table striped verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('approval.field.employee')}</Table.Th>
            <Table.Th>{t('request.field.kind')}</Table.Th>
            <Table.Th>{t('request.field.dates')}</Table.Th>
            <Table.Th>{t('request.field.state')}</Table.Th>
            <Table.Th>{t('approval.field.decision')}</Table.Th>
            <Table.Th>{t('approval.field.decidedAt')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {props.items.map((item) => (
            <Table.Tr key={item.id}>
              <Table.Td fw={500}>{item.employeeName}</Table.Td>
              <Table.Td>{t(kindKeys[item.kind])}</Table.Td>
              <Table.Td>{dateRange(item.startDate, item.endDate)}</Table.Td>
              <Table.Td>
                <RequestStateBadge state={item.state} />
              </Table.Td>
              <Table.Td>{t(decisionKey(item.decision))}</Table.Td>
              <Table.Td>{formatDateTime(item.decision.decidedAt, locale)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

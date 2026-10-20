import { Badge } from '@mantine/core';
import { useI18n } from '../../i18n/i18n.provider';
import type { RequestState } from '../work-request.client';
import { stateKeys } from '../work-request.helper';

const colors: Readonly<Record<RequestState, string>> = {
  pending_lead: 'yellow',
  pending_final: 'yellow',
  approved: 'green',
  rejected: 'red',
  cancelled: 'gray',
};

/** State always carries its text, never color alone (design system §5). */
export function RequestStateBadge(props: { readonly state: RequestState }) {
  const { t } = useI18n();
  return (
    <Badge color={colors[props.state]} variant="light">
      {t(stateKeys[props.state])}
    </Badge>
  );
}

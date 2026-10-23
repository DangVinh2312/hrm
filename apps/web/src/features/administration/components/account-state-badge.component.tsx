import { Badge } from '@mantine/core';
import type { AccountRow } from '../administration.client';
import { useI18n } from '../../../i18n/i18n.provider';

const colors: Readonly<Record<AccountRow['state'], string>> = {
  active: 'green',
  pending: 'yellow',
  suspended: 'gray',
};

/** State always carries its text, never color alone (design system §5). */
export function AccountStateBadge(props: { readonly state: AccountRow['state'] }) {
  const { t } = useI18n();
  return (
    <Badge color={colors[props.state]} variant="light">
      {t(`administration.accounts.state.${props.state}`)}
    </Badge>
  );
}

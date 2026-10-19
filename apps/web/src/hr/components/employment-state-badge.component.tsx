import { Badge } from '@mantine/core';
import type { EmploymentState } from '../../employee/employee.client';
import { useI18n } from '../../i18n/i18n.provider';

const colors: Readonly<Record<EmploymentState, string>> = {
  probation: 'yellow',
  official: 'green',
  notStarted: 'brand',
  terminated: 'gray',
};

/** Status always carries its text, never color alone (design system §5). */
export function EmploymentStateBadge(props: { readonly state: EmploymentState }) {
  const { t } = useI18n();
  return (
    <Badge color={colors[props.state]} variant="light">
      {t(`employee.state.${props.state}`)}
    </Badge>
  );
}

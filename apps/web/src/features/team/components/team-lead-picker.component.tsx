import { Select } from '@mantine/core';
import { useI18n } from '../../../i18n/i18n.provider';
import type { Team } from '../team.client';

/**
 * Next-lead select over the open members of this team only (ADR 0040: a lead is a member); the
 * current lead is left out. The API still enforces it (`lead_not_member`).
 */
export function TeamLeadPicker(props: {
  readonly members: Team['members'];
  readonly currentLeadId: string | null;
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}) {
  const { t } = useI18n();
  const data = props.members
    .filter((row) => row.employeeId !== props.currentLeadId)
    .map((row) => ({ value: row.employeeId, label: `${row.code} · ${row.fullName}` }));
  return (
    <Select
      label={t('team.lead.choose')}
      description={t('team.lead.memberHint')}
      data={data}
      value={props.value}
      onChange={props.onChange}
      searchable
      clearable
      nothingFoundMessage={t('team.picker.noMatch')}
    />
  );
}

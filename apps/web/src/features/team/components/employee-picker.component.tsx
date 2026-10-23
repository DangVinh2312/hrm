import { Select } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../auth/session.provider';
import { useEmployeeClient } from '../../employee/employee-services.provider';
import { useI18n } from '../../../i18n/i18n.provider';

/**
 * Searchable employee select over the caller's scope (`GET /api/hr/employees`). Returns the id.
 * shortcut: loads the first 100 employees and filters in the browser — enough for ~50 staff;
 * switch to server-side search when the company outgrows one page.
 */
export function EmployeePicker(props: {
  readonly label: string;
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly exclude?: readonly string[];
}) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const employees = useEmployeeClient();
  const list = useQuery({
    queryKey: [namespace, 'employees', 'list', { page: 1, search: '', size: 100 }],
    queryFn: ({ signal }) => employees.list({ page: 1, search: '', size: 100 }, signal),
  });
  const data = (list.data?.items ?? [])
    .filter((item) => !props.exclude?.includes(item.id) && item.state !== 'terminated')
    .map((item) => ({ value: item.id, label: `${item.code} · ${item.fullName}` }));
  return (
    <Select
      label={props.label}
      data={data}
      value={props.value}
      onChange={props.onChange}
      searchable
      clearable
      nothingFoundMessage={t(list.isPending ? 'common.loading' : 'team.picker.noMatch')}
    />
  );
}

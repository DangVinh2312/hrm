import {
  Anchor,
  Button,
  Card,
  Center,
  Group,
  Pagination,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconSearch, IconUserPlus, IconUsers } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useSession } from '../../auth/session.provider';
import { EmploymentStateBadge } from '../components/employment-state-badge.component';
import { QueryState } from '../../../components/query-state.component';
import { useEmployeeClient, useOwnEmployee } from '../employee-services.provider';
import { useI18n } from '../../../i18n/i18n.provider';
import { EmployeeCreateModal } from '../components/employee-create.component';
import { EMPLOYEE_PAGE_SIZE } from '../employee.client';

/** `?page=` and `?search=` live in the URL (design §10.3); no PII is ever put there. */
function pageFrom(params: URLSearchParams): number {
  const page = Number(params.get('page') ?? '1');
  return Number.isSafeInteger(page) && page >= 1 && page <= 500 ? page : 1;
}

/** Employees the caller may see (scope decided by the API: self, team, company). */
export function EmployeeListPage() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const employees = useEmployeeClient();
  // Display hint only, like the detail and team pages; the API authorizes the create itself.
  const canCreate = useOwnEmployee().data?.companyScope === true;
  const [params, setParams] = useSearchParams();
  const page = pageFrom(params);
  const search = (params.get('search') ?? '').slice(0, 100);
  const [draft, setDraft] = useState(search);
  const [creating, { open, close }] = useDisclosure();
  const list = useQuery({
    queryKey: [namespace, 'employees', 'list', { page, search }],
    queryFn: ({ signal }) => employees.list({ page, search }, signal),
    placeholderData: keepPreviousData,
  });
  const total = Number(list.data?.total ?? '0');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    if (draft.trim()) next.set('search', draft.trim().slice(0, 100));
    setParams(next);
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Title order={1}>{t('employee.list.title')}</Title>
          <Text c="dimmed" mt={4}>
            {t('employee.list.description')}
          </Text>
        </div>
        {canCreate && (
          <Button leftSection={<IconUserPlus size={18} stroke={1.75} aria-hidden />} onClick={open}>
            {t('employee.create.open')}
          </Button>
        )}
      </Group>
      <Card padding="lg">
        <Stack gap="md">
          <form onSubmit={submit} role="search">
            <Group align="flex-end" wrap="nowrap">
              <TextInput
                flex={1}
                label={t('employee.list.searchLabel')}
                placeholder={t('employee.list.searchPlaceholder')}
                value={draft}
                maxLength={100}
                onChange={(event) => setDraft(event.currentTarget.value)}
                leftSection={<IconSearch size={18} stroke={1.75} aria-hidden />}
              />
              <Button type="submit" variant="light">
                {t('employee.list.searchSubmit')}
              </Button>
            </Group>
          </form>
          <QueryState pending={list.isPending} error={list.error} onRetry={() => list.refetch()}>
            {list.data?.items.length === 0 ? (
              <Center py="xl">
                <Stack align="center" gap="xs">
                  <ThemeIcon size={44} radius="md" variant="light" color="gray" aria-hidden>
                    <IconUsers size={24} stroke={1.75} />
                  </ThemeIcon>
                  <Text c="dimmed">
                    {t(search ? 'employee.list.noMatch' : 'employee.list.empty')}
                  </Text>
                </Stack>
              </Center>
            ) : (
              <Table.ScrollContainer minWidth={560}>
                <Table striped highlightOnHover verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('employee.field.code')}</Table.Th>
                      <Table.Th>{t('employee.field.fullName')}</Table.Th>
                      <Table.Th>{t('employee.field.primaryTeam')}</Table.Th>
                      <Table.Th>{t('employee.field.status')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {list.data?.items.map((item) => (
                      <Table.Tr key={item.id}>
                        <Table.Td>
                          <Anchor component={Link} to={`/employees/${item.id}`} fw={500}>
                            {item.code}
                          </Anchor>
                        </Table.Td>
                        <Table.Td>{item.fullName}</Table.Td>
                        <Table.Td>{item.primaryTeam?.name ?? '—'}</Table.Td>
                        <Table.Td>
                          <EmploymentStateBadge state={item.state} />
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
            {total > EMPLOYEE_PAGE_SIZE && (
              <Group justify="center">
                <Pagination
                  total={Math.ceil(total / EMPLOYEE_PAGE_SIZE)}
                  value={page}
                  onChange={(next) => {
                    const nextParams = new URLSearchParams(params);
                    nextParams.set('page', String(next));
                    setParams(nextParams);
                  }}
                  getControlProps={(control) => ({
                    'aria-label': t(control === 'next' ? 'common.nextPage' : 'common.previousPage'),
                  })}
                  withEdges={false}
                />
              </Group>
            )}
          </QueryState>
        </Stack>
      </Card>
      <EmployeeCreateModal opened={creating} onClose={close} />
    </Stack>
  );
}

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
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconFileText, IconPlus } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { useSession } from '../../auth/session.provider';
import { QueryState } from '../../hr/components/query-state.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { formatDate } from '../../i18n/format.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { REQUEST_PAGE_SIZE } from '../work-request.client';
import { RequestStateBadge } from '../components/request-state-badge.component';
import { kindKeys } from '../work-request.helper';

/** `?page=` lives in the URL (design §10.3); the API caps the offset, so does this. */
function pageFrom(params: URLSearchParams): number {
  const page = Number(params.get('page') ?? '1');
  return Number.isSafeInteger(page) && page >= 1 && page <= 500 ? page : 1;
}

const dates = (start: string, end: string) =>
  start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;

/** The signed-in employee's own requests, newest first (the API scopes them to the owner). */
export function RequestListPage() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const { workRequest } = useHrServices();
  const [params, setParams] = useSearchParams();
  const page = pageFrom(params);
  const list = useQuery({
    queryKey: [namespace, 'requests', 'list', page],
    queryFn: ({ signal }) => workRequest.list({ page }, signal),
    placeholderData: keepPreviousData,
  });
  const total = Number(list.data?.total ?? '0');

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Title order={1}>{t('request.list.title')}</Title>
          <Text c="dimmed" mt={4}>
            {t('request.list.description')}
          </Text>
        </div>
        <Button
          component={Link}
          to="/requests/new"
          leftSection={<IconPlus size={18} stroke={1.75} aria-hidden />}
        >
          {t('request.list.new')}
        </Button>
      </Group>
      <Card padding="lg">
        <QueryState pending={list.isPending} error={list.error} onRetry={() => list.refetch()}>
          <Stack gap="md">
            {list.data?.items.length === 0 ? (
              <Center py="xl">
                <Stack align="center" gap="xs">
                  <ThemeIcon size={44} radius="md" variant="light" color="gray" aria-hidden>
                    <IconFileText size={24} stroke={1.75} />
                  </ThemeIcon>
                  <Text c="dimmed">{t('request.list.empty')}</Text>
                </Stack>
              </Center>
            ) : (
              <Table.ScrollContainer minWidth={560}>
                <Table striped highlightOnHover verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('request.field.kind')}</Table.Th>
                      <Table.Th>{t('request.field.dates')}</Table.Th>
                      <Table.Th>{t('request.field.state')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {list.data?.items.map((item) => (
                      <Table.Tr key={item.id}>
                        <Table.Td>
                          <Anchor component={Link} to={`/requests/${item.id}`} fw={500}>
                            {t(kindKeys[item.kind])}
                          </Anchor>
                        </Table.Td>
                        <Table.Td>{dates(item.startDate, item.endDate)}</Table.Td>
                        <Table.Td>
                          <RequestStateBadge state={item.state} />
                        </Table.Td>
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
                  onChange={(next) => setParams(new URLSearchParams({ page: String(next) }))}
                  getControlProps={(control) => ({
                    'aria-label': t(control === 'next' ? 'common.nextPage' : 'common.previousPage'),
                  })}
                  withEdges={false}
                />
              </Group>
            )}
          </Stack>
        </QueryState>
      </Card>
    </Stack>
  );
}

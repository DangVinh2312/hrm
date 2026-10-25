import {
  Alert,
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
import { IconAlertCircle, IconUsers } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryState } from '../../components/query-state.component';
import { useI18n } from '../../i18n/i18n.provider';
import { useMenus } from '../auth/me.provider';
import { useSession } from '../auth/session.provider';
import { useAdministrationClient } from './administration-services.provider';
import { ACCOUNT_PAGE_SIZE } from './administration.client';
import { AccountAction } from './components/account-action.component';
import { AccountPermissions } from './components/account-permissions.component';
import { AccountProvision } from './components/account-provision.component';
import { AccountStateBadge } from './components/account-state-badge.component';

/**
 * IAM accounts (ADR 0041 wave 1): add by email, suspend, restore. The menu `accounts` is a display
 * hint from the server: without it the page is "not found" and asks for nothing; the API still
 * authorizes every request. Root never appears in the list (the API projection is IAM only).
 */
export function AccountPage() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const menus = useMenus();
  const [page, setPage] = useState(1);
  const allowed = menus.data?.menus.includes('accounts') === true;
  const list = useQuery({
    queryKey: [namespace, 'administration', 'accounts', page],
    enabled: allowed,
    queryFn: ({ signal }) => administration.list({ page }, signal),
    placeholderData: keepPreviousData,
  });
  const total = Number(list.data?.total ?? '0');
  const ownId = menus.data?.userId;

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('administration.accounts.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('administration.accounts.description')}
        </Text>
      </div>
      <QueryState pending={menus.isPending} error={menus.error} onRetry={() => menus.refetch()}>
        {!allowed ? (
          <Alert
            color="gray"
            title={t('notFound.title')}
            icon={<IconAlertCircle size={18} aria-hidden />}
          >
            {t('notFound.body')}
          </Alert>
        ) : (
          <Stack gap="lg">
            <AccountProvision />
            <Card padding="lg">
              <QueryState
                pending={list.isPending}
                error={list.error}
                onRetry={() => list.refetch()}
              >
                {list.data?.items.length === 0 ? (
                  <Center py="xl">
                    <Stack align="center" gap="xs">
                      <ThemeIcon size={44} radius="md" variant="light" color="gray" aria-hidden>
                        <IconUsers size={24} stroke={1.75} />
                      </ThemeIcon>
                      <Text c="dimmed">{t('administration.accounts.empty')}</Text>
                    </Stack>
                  </Center>
                ) : (
                  <Table.ScrollContainer minWidth={560}>
                    <Table verticalSpacing="sm" aria-label={t('administration.accounts.listLabel')}>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{t('administration.accounts.field.email')}</Table.Th>
                          <Table.Th>{t('administration.accounts.field.state')}</Table.Th>
                          <Table.Th>{t('administration.accounts.field.invitation')}</Table.Th>
                          <Table.Th>{t('common.actions')}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {list.data?.items.map((account) => (
                          <Table.Tr key={account.userId}>
                            <Table.Td>
                              {account.email ?? '—'}
                              {account.userId === ownId && (
                                <Text span c="dimmed" size="sm">
                                  {' '}
                                  {t('administration.accounts.you')}
                                </Text>
                              )}
                            </Table.Td>
                            <Table.Td>
                              <AccountStateBadge state={account.state} />
                            </Table.Td>
                            <Table.Td>
                              {account.enrollment === null
                                ? '—'
                                : t(`administration.accounts.invitation.${account.enrollment}`)}
                              {account.state === 'pending' && account.enrollment !== 'pending' && (
                                <Text size="xs" c="dimmed">
                                  {t('administration.accounts.invitation.expiredHint')}
                                </Text>
                              )}
                            </Table.Td>
                            <Table.Td>
                              <Group gap="xs" wrap="nowrap">
                                <AccountPermissions account={account} />
                                {account.userId !== ownId && <AccountAction account={account} />}
                              </Group>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                )}
                {total > ACCOUNT_PAGE_SIZE && (
                  <Group justify="center" mt="md">
                    <Pagination
                      total={Math.ceil(total / ACCOUNT_PAGE_SIZE)}
                      value={page}
                      onChange={setPage}
                      getControlProps={(control) => ({
                        'aria-label': t(
                          control === 'next' ? 'common.nextPage' : 'common.previousPage',
                        ),
                      })}
                      withEdges={false}
                    />
                  </Group>
                )}
              </QueryState>
            </Card>
          </Stack>
        )}
      </QueryState>
    </Stack>
  );
}

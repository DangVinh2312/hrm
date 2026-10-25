import { Badge, Button, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconShieldCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { QueryState } from '../../../components/query-state.component';
import { useI18n } from '../../../i18n/i18n.provider';
import { useSession } from '../../auth/session.provider';
import { useAdministrationClient } from '../administration-services.provider';
import type { AccountRow } from '../administration.client';
import { GrantGroups } from './grant-groups.component';

/**
 * The roles and rules of one account, read on demand when the dialog opens (never for every row).
 * `account.readPermissions` is checked by the API: a person without it, or an account the API does
 * not reach, gets the same "not found" text.
 */
export function AccountPermissions(props: { readonly account: AccountRow }) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const [opened, dialog] = useDisclosure();
  const { account } = props;
  const detail = useQuery({
    queryKey: [namespace, 'administration', 'account-permissions', account.userId],
    enabled: opened,
    queryFn: ({ signal }) => administration.accountPermissions(account.userId, signal),
  });
  return (
    <>
      <Button
        size="xs"
        variant="default"
        aria-label={`${t('administration.accounts.permissions')} ${account.email ?? account.userId}`}
        leftSection={<IconShieldCheck size={16} stroke={1.75} aria-hidden />}
        onClick={dialog.open}
      >
        {t('administration.accounts.permissions')}
      </Button>
      <Modal
        opened={opened}
        onClose={dialog.close}
        title={t('administration.accounts.permissions.title')}
      >
        <QueryState
          pending={detail.isPending}
          error={detail.error}
          onRetry={() => detail.refetch()}
        >
          <Stack gap="md">
            <Text size="sm" fw={600}>
              {account.email ?? account.userId}
            </Text>
            <Stack gap="xs">
              <Title order={3} size="h5">
                {t('administration.accounts.permissions.roles')}
              </Title>
              {detail.data?.roles.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('administration.accounts.permissions.noRoles')}
                </Text>
              ) : (
                <Group gap="xs">
                  {detail.data?.roles.map((role) => (
                    <Badge key={role.key} variant="light" color="gray" tt="none">
                      {role.label || role.key}
                    </Badge>
                  ))}
                </Group>
              )}
            </Stack>
            <Stack gap="xs">
              <Title order={3} size="h5">
                {t('administration.accounts.permissions.grants')}
              </Title>
              {detail.data?.grants.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('administration.accounts.permissions.noGrants')}
                </Text>
              ) : (
                <GrantGroups grants={detail.data?.grants ?? []} />
              )}
            </Stack>
          </Stack>
        </QueryState>
      </Modal>
    </>
  );
}

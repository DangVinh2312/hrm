import { Alert, Button, Modal, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertCircle, IconShieldCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { QueryState } from '../../../components/query-state.component';
import { useI18n } from '../../../i18n/i18n.provider';
import { useSession } from '../../auth/session.provider';
import { useAdministrationClient } from '../administration-services.provider';
import type { AccountRow } from '../administration.client';
import { IDENTITY_PACKAGE } from '../role.helper';
import { AccountBoundary } from './account-boundary.component';
import { AccountIdentity } from './account-identity.component';
import { AccountRoles } from './account-roles.component';
import { GrantGroups } from './grant-groups.component';

const isIdentity = (b: { readonly permission: string }) =>
  (IDENTITY_PACKAGE.permissions as readonly string[]).includes(b.permission);

/**
 * The roles and rules of one account, read on demand when the dialog opens (never for every row).
 * `account.readPermissions` is checked by the API: a person without it, or an account the API does
 * not reach, gets the same "not found" text.
 */
export function AccountPermissions(props: {
  readonly account: AccountRow;
  /** The caller's own row: the API refuses every write on oneself, so none is offered. */
  readonly readOnly: boolean;
}) {
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
  const boundaries = detail.data?.boundaries ?? [];
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
            {detail.data?.truncated === true && (
              <Alert color="yellow" role="status" icon={<IconAlertCircle size={18} aria-hidden />}>
                {t('administration.accounts.permissions.truncated')}
              </Alert>
            )}
            <AccountRoles
              account={account}
              roles={detail.data?.roles ?? []}
              readOnly={props.readOnly}
            />
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
            <AccountBoundary
              kind="administration"
              account={account}
              boundaries={boundaries.filter((b) => !isIdentity(b))}
              readOnly={props.readOnly}
            />
            <AccountBoundary
              kind="identity"
              account={account}
              boundaries={boundaries.filter(isIdentity)}
              readOnly={props.readOnly}
            />
            {!props.readOnly && <AccountIdentity account={account} />}
          </Stack>
        </QueryState>
      </Modal>
    </>
  );
}

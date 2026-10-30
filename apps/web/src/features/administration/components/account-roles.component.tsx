import { Alert, Badge, Button, Group, Select, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n.provider';
import { MutationError } from '../../account/components/mutation-error.component';
import { useSession } from '../../auth/session.provider';
import { useAdministrationClient } from '../administration-services.provider';
import type { AccountPermissions, AccountRow } from '../administration.client';
import { ConfirmPanel } from './confirm-panel.component';
import { RoleCapabilities } from './role-capabilities.component';

/**
 * The roles one account holds, with revoke (after a confirmation) and assign. The roles to choose
 * from are the ones `role.read` returns to the caller; without that read nothing can be chosen.
 * Which roles the caller may actually give is the API's call (fresh auth, boundary, grant set).
 */
export function AccountRoles(props: {
  readonly account: AccountRow;
  readonly roles: AccountPermissions['roles'];
  readonly readOnly: boolean;
}) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const queryClient = useQueryClient();
  const { account, roles } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AccountPermissions['roles'][number] | null>(null);
  const [done, setDone] = useState<'assign' | 'revoke' | null>(null);
  const catalog = useQuery({
    queryKey: [namespace, 'administration', 'roles'],
    enabled: !props.readOnly,
    queryFn: ({ signal }) => administration.roles(signal),
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: [namespace, 'administration', 'account-permissions', account.userId],
    });
    await queryClient.invalidateQueries({ queryKey: [namespace, 'administration', 'roles'] });
  };
  const assign = useMutation({
    mutationFn: (roleKey: string) => administration.assignRole(account.userId, roleKey),
    onSuccess: async () => {
      setSelected(null);
      setDone('assign');
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (roleKey: string) => administration.revokeRole(account.userId, roleKey),
    onSuccess: async () => {
      setRevoking(null);
      setDone('revoke');
      await refresh();
    },
  });
  const held = new Set(roles.map((role) => role.key));
  const choices = (catalog.data?.roles ?? []).filter((role) => !held.has(role.key));
  const chosen = choices.find((role) => role.key === selected);
  return (
    <Stack gap="xs">
      <Title order={3} size="h5">
        {t('administration.accounts.permissions.roles')}
      </Title>
      {roles.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('administration.accounts.permissions.noRoles')}
        </Text>
      ) : (
        <Stack gap={6}>
          {roles.map((role) => (
            <Group key={role.key} justify="space-between" wrap="nowrap" gap="xs">
              <Badge variant="light" color="gray" tt="none">
                {role.label || role.key}
              </Badge>
              {!props.readOnly && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  aria-label={`${t('administration.accounts.roles.revoke')} ${role.label || role.key}`}
                  onClick={() => {
                    revoke.reset();
                    setDone(null);
                    setRevoking(role);
                  }}
                >
                  {t('administration.accounts.roles.revoke')}
                </Button>
              )}
            </Group>
          ))}
        </Stack>
      )}
      {revoking && (
        <ConfirmPanel
          title="administration.accounts.roles.revoke.title"
          body="administration.accounts.roles.revoke.body"
          confirm="administration.accounts.roles.revoke.confirm"
          subject={revoking.label || revoking.key}
          loading={revoke.isPending}
          error={revoke.error}
          onConfirm={() => revoke.mutate(revoking.key)}
          onCancel={() => setRevoking(null)}
        />
      )}
      {!props.readOnly && catalog.isError && (
        <Text size="sm" c="dimmed">
          {t('administration.accounts.roles.assign.unavailable')}
        </Text>
      )}
      {!props.readOnly && catalog.data && choices.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('administration.accounts.roles.assign.none')}
        </Text>
      )}
      {!props.readOnly && choices.length > 0 && (
        <Stack gap="xs">
          <Group align="flex-end" wrap="wrap">
            <Select
              flex={1}
              miw={200}
              searchable
              allowDeselect={false}
              label={t('administration.accounts.roles.assign.label')}
              data={choices.map((role) => ({ value: role.key, label: role.label || role.key }))}
              value={selected}
              onChange={(value) => {
                assign.reset();
                setDone(null);
                setSelected(value);
              }}
            />
            <Button
              loading={assign.isPending}
              onClick={() => {
                if (selected === null) return;
                setDone(null);
                assign.mutate(selected);
              }}
            >
              {t('administration.accounts.roles.assign.submit')}
            </Button>
          </Group>
          {chosen?.capabilities.includes('selfApproval') && (
            <Alert color="yellow" role="status" icon={<IconAlertCircle size={18} aria-hidden />}>
              {t('administration.accounts.roles.assign.selfApproval')}
            </Alert>
          )}
          {chosen && chosen.capabilities.some((c) => c !== 'selfApproval') && (
            <Stack gap={4}>
              <Text size="sm">{t('administration.accounts.roles.assign.capabilities')}</Text>
              <RoleCapabilities
                capabilities={chosen.capabilities.filter((c) => c !== 'selfApproval')}
              />
            </Stack>
          )}
          <MutationError error={assign.error} />
        </Stack>
      )}
      {done !== null && (
        <Text size="sm" role="status">
          {t(`administration.accounts.roles.${done}.done`)}
        </Text>
      )}
    </Stack>
  );
}

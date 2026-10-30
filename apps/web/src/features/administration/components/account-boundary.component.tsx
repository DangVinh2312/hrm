import { Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n.provider';
import { MutationError } from '../../account/components/mutation-error.component';
import { useSession } from '../../auth/session.provider';
import { useAdministrationClient } from '../administration-services.provider';
import type { AccountPermissions, AccountRow } from '../administration.client';
import { ADMINISTRATION_PACKAGE, IDENTITY_PACKAGE, packageBinding } from '../role.helper';
import { ConfirmPanel } from './confirm-panel.component';

const PACKAGES = {
  administration: { pkg: ADMINISTRATION_PACKAGE, text: 'administration.accounts.boundary' },
  identity: { pkg: IDENTITY_PACKAGE, text: 'administration.accounts.identityBoundary' },
} as const;

/**
 * Whether the account is bound to the `accountAdministration@1` package (account and role
 * commands) or the `identityAdministration@1` package (ADR-15), which those commands need besides
 * a grant. Giving a role never binds it. The API binds or unbinds the whole package in one step;
 * a half-bound package cannot be bound again (409), so it offers no bind.
 */
export function AccountBoundary(props: {
  readonly account: AccountRow;
  readonly boundaries: AccountPermissions['boundaries'];
  readonly readOnly: boolean;
  readonly kind: keyof typeof PACKAGES;
}) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const queryClient = useQueryClient();
  const { account, boundaries } = props;
  const { pkg, text } = PACKAGES[props.kind];
  const ref = { key: pkg.key, version: pkg.version };
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<'bind' | 'unbind' | null>(null);
  const view = packageBinding(boundaries, pkg);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: [namespace, 'administration', 'account-permissions', account.userId],
    });
  const bind = useMutation({
    mutationFn: () => administration.bindBoundary(account.userId, ref),
    onSuccess: async () => {
      setDone('bind');
      await refresh();
    },
  });
  const unbind = useMutation({
    mutationFn: () => administration.unbindBoundary(account.userId, ref),
    onSuccess: async () => {
      setConfirming(false);
      setDone('unbind');
      await refresh();
    },
  });
  return (
    <Stack component="section" gap="xs" aria-label={t(`${text}.title`)}>
      <Title order={3} size="h5">
        {t(`${text}.title`)}
      </Title>
      <Text size="sm" c="dimmed">
        {t(`${text}.hint`)}
      </Text>
      <Group gap="xs">
        <Badge variant="light" color={view.state === 'full' ? 'green' : 'gray'} tt="none">
          {t(`administration.accounts.boundary.state.${view.state}`)}
        </Badge>
      </Group>
      {view.state === 'partial' && (
        <Text size="sm">
          {`${t('administration.accounts.boundary.missing')}: ${view.missing.join(', ')}. ${t('administration.accounts.boundary.partialHint')}`}
        </Text>
      )}
      {boundaries.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('administration.accounts.boundary.noBindings')}
        </Text>
      ) : (
        <Group gap="xs" aria-label={t('administration.accounts.boundary.bindings')} role="group">
          {boundaries.map((binding) => (
            <Badge key={binding.permission} variant="light" color="gray" tt="none">
              {`${binding.permission} · ${binding.key}@${binding.version}${binding.seeded ? ` (${t('administration.accounts.boundary.seeded')})` : ''}`}
            </Badge>
          ))}
        </Group>
      )}
      {!props.readOnly && (
        <Group gap="xs">
          {view.state === 'none' && (
            <Button
              size="xs"
              loading={bind.isPending}
              onClick={() => {
                bind.reset();
                setDone(null);
                bind.mutate();
              }}
            >
              {t('administration.accounts.boundary.bind')}
            </Button>
          )}
          {view.removable && !confirming && (
            <Button
              size="xs"
              variant="light"
              color="red"
              onClick={() => {
                unbind.reset();
                setDone(null);
                setConfirming(true);
              }}
            >
              {t('administration.accounts.boundary.unbind')}
            </Button>
          )}
        </Group>
      )}
      <MutationError error={bind.error} />
      {confirming && (
        <ConfirmPanel
          title={`${text}.unbind.title`}
          body={`${text}.unbind.body`}
          confirm="administration.accounts.boundary.unbind.confirm"
          loading={unbind.isPending}
          error={unbind.error}
          onConfirm={() => unbind.mutate()}
          onCancel={() => setConfirming(false)}
        />
      )}
      {done !== null && (
        <Text size="sm" role="status">
          {t(`${text}.${done}.done`)}
        </Text>
      )}
    </Stack>
  );
}

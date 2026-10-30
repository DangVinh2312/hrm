import { Button, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n.provider';
import { useSession } from '../../auth/session.provider';
import { emailSchema } from '../account-email.helper';
import { useAdministrationClient } from '../administration-services.provider';
import type { AccountRow } from '../administration.client';
import { ConfirmPanel } from './confirm-panel.component';

type Operation = 'email' | 'mfa' | 'google';
const OPERATIONS: readonly Operation[] = ['email', 'mfa', 'google'];

/**
 * `account.changeEmail`, `account.resetMfa`, `account.resetGoogleBinding` on another IAM account.
 * Each is confirmed in place with its consequence spelled out; the API decides everything (fresh
 * authentication, boundary, self and Root rules). The 409 texts say no more than the caller
 * already knows, and no success text names the email or any secret.
 */
export function AccountIdentity(props: { readonly account: AccountRow }) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const queryClient = useQueryClient();
  const { userId } = props.account;
  const [active, setActive] = useState<Operation | null>(null);
  const [done, setDone] = useState<Operation | null>(null);
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const run = useMutation({
    mutationFn: (input: { readonly op: Operation; readonly email: string }) =>
      input.op === 'email'
        ? administration.changeEmail(userId, input.email)
        : input.op === 'mfa'
          ? administration.resetMfa(userId)
          : administration.resetGoogleBinding(userId),
    onSuccess: async (_result, { op }) => {
      setActive(null);
      setValue('');
      setDone(op);
      await queryClient.invalidateQueries({
        queryKey: [namespace, 'administration', 'account-permissions', userId],
      });
      await queryClient.invalidateQueries({ queryKey: [namespace, 'administration', 'accounts'] });
    },
  });
  const open = (op: Operation) => {
    run.reset();
    setDone(null);
    setInvalid(false);
    setActive(op);
  };
  const confirm = (op: Operation) => {
    if (op !== 'email') return run.mutate({ op, email: '' });
    const parsed = emailSchema.safeParse(value);
    setInvalid(!parsed.success);
    if (parsed.success) run.mutate({ op, email: parsed.data });
  };
  return (
    <Stack component="section" gap="xs" aria-label={t('administration.accounts.identity.title')}>
      <Title order={3} size="h5">
        {t('administration.accounts.identity.title')}
      </Title>
      <Text size="sm" c="dimmed">
        {t('administration.accounts.identity.hint')}
      </Text>
      <Group gap="xs">
        {OPERATIONS.map((op) => (
          <Button
            key={op}
            size="xs"
            variant="light"
            color="red"
            disabled={run.isPending}
            onClick={() => open(op)}
          >
            {t(`administration.accounts.identity.${op}`)}
          </Button>
        ))}
      </Group>
      {active === 'email' && (
        <TextInput
          type="email"
          label={t('administration.accounts.identity.email.field')}
          value={value}
          maxLength={254}
          withAsterisk
          error={invalid ? t('administration.accounts.emailInvalid') : undefined}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      )}
      {active !== null && (
        <ConfirmPanel
          title={`administration.accounts.identity.${active}.title`}
          body={`administration.accounts.identity.${active}.body`}
          confirm={`administration.accounts.identity.${active}.confirm`}
          conflict={`administration.accounts.identity.${active}.conflict`}
          loading={run.isPending}
          error={run.error}
          onConfirm={() => confirm(active)}
          onCancel={() => setActive(null)}
        />
      )}
      {done !== null && (
        <Text size="sm" role="status">
          {t(`administration.accounts.identity.${done}.done`)}
        </Text>
      )}
    </Stack>
  );
}

import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconLock, IconLockOpen } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../auth/session.provider';
import { MutationError } from '../../account/components/mutation-error.component';
import { useAdministrationClient } from '../administration-services.provider';
import type { AccountRow } from '../administration.client';
import { useI18n } from '../../../i18n/i18n.provider';

/**
 * Suspend or restore one account behind a confirmation dialog. The API decides everything
 * (fresh auth, boundary, self and Root rules); 409 on restore means the account is no longer
 * suspended, which the shared conflict text explains.
 */
export function AccountAction(props: { readonly account: AccountRow }) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const queryClient = useQueryClient();
  const [opened, dialog] = useDisclosure();
  const { account } = props;
  const restoring = account.state === 'suspended';
  const email = account.email ?? account.userId;
  const verb = restoring ? 'restore' : 'suspend';
  const change = useMutation({
    mutationFn: () =>
      restoring
        ? administration.reactivate(account.userId)
        : administration.suspend(account.userId),
    onSuccess: async () => {
      dialog.close();
      await queryClient.invalidateQueries({ queryKey: [namespace, 'administration', 'accounts'] });
    },
  });
  return (
    <>
      <Button
        size="xs"
        variant="light"
        color={restoring ? 'brand' : 'red'}
        aria-label={`${t(`administration.accounts.${verb}`)} ${email}`}
        leftSection={
          restoring ? (
            <IconLockOpen size={16} stroke={1.75} aria-hidden />
          ) : (
            <IconLock size={16} stroke={1.75} aria-hidden />
          )
        }
        onClick={() => {
          change.reset();
          dialog.open();
        }}
      >
        {t(`administration.accounts.${verb}`)}
      </Button>
      <Modal
        opened={opened}
        onClose={dialog.close}
        title={t(`administration.accounts.${verb}.title`)}
      >
        <Stack gap="md">
          <Text size="sm">{t(`administration.accounts.${verb}.body`)}</Text>
          <Text size="sm" fw={600}>
            {email}
          </Text>
          <MutationError error={change.error} />
          <Group justify="flex-end">
            <Button variant="default" onClick={dialog.close}>
              {t('common.cancel')}
            </Button>
            <Button
              color={restoring ? 'brand' : 'red'}
              loading={change.isPending}
              onClick={() => change.mutate()}
            >
              {t(`administration.accounts.${verb}.confirm`)}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

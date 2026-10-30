import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconTrash } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../../i18n/i18n.provider';
import { MutationError } from '../../account/components/mutation-error.component';
import { useSession } from '../../auth/session.provider';
import { useAdministrationClient } from '../administration-services.provider';
import type { RoleRow } from '../administration.client';

/**
 * Delete one runtime role behind a confirmation. The button is disabled while the role has
 * holders (a hint: the API answers 409 for that and for exceptions that still name the role).
 */
export function RoleDelete(props: { readonly role: RoleRow }) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const queryClient = useQueryClient();
  const [opened, dialog] = useDisclosure();
  const { role } = props;
  const name = role.label || role.key;
  const remove = useMutation({
    mutationFn: () => administration.deleteRole(role.key),
    onSuccess: async () => {
      dialog.close();
      await queryClient.invalidateQueries({ queryKey: [namespace, 'administration', 'roles'] });
    },
  });
  return (
    <>
      <Stack gap={4} align="flex-start">
        <Button
          size="xs"
          variant="light"
          color="red"
          disabled={role.holders > 0}
          aria-label={`${t('administration.roles.delete')} ${name}`}
          leftSection={<IconTrash size={16} stroke={1.75} aria-hidden />}
          onClick={() => {
            remove.reset();
            dialog.open();
          }}
        >
          {t('administration.roles.delete')}
        </Button>
        {role.holders > 0 && (
          <Text size="xs" c="dimmed">
            {t('administration.roles.delete.held')}
          </Text>
        )}
      </Stack>
      <Modal opened={opened} onClose={dialog.close} title={t('administration.roles.delete.title')}>
        <Stack gap="md">
          <Text size="sm">{t('administration.roles.delete.body')}</Text>
          <Text size="sm" fw={600}>
            {name}
          </Text>
          <MutationError error={remove.error} />
          <Group justify="flex-end">
            <Button variant="default" onClick={dialog.close}>
              {t('common.cancel')}
            </Button>
            <Button color="red" loading={remove.isPending} onClick={() => remove.mutate()}>
              {t('administration.roles.delete.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

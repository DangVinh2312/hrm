import { Button, Group, Stack, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { MutationError } from '../../hr/components/mutation-error.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { useI18n } from '../../../i18n/i18n.provider';
import type { Team } from '../team.client';
import { useTeamRefresh } from '../team.helper';

export function RenameForm(props: { readonly team: Team; readonly onClose: () => void }) {
  const { t } = useI18n();
  const { teams } = useHrServices();
  const refresh = useTeamRefresh();
  const [name, setName] = useState(props.team.name);
  const valid = name.trim().length > 0 && name.trim().length <= 200;
  const rename = useMutation({
    mutationFn: () =>
      teams.rename(props.team.id, { expectedVersion: props.team.version, name: name.trim() }),
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) rename.mutate();
      }}
      noValidate
    >
      <Stack gap="md">
        <MutationError error={rename.error} />
        <TextInput
          label={t('team.field.name')}
          value={name}
          maxLength={200}
          withAsterisk
          onChange={(event) => setName(event.currentTarget.value)}
          error={valid ? undefined : t('employee.form.required')}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={rename.isPending} disabled={!valid}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

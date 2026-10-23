import { Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconUserPlus } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../auth/session.provider';
import { MutationError } from '../../account/components/mutation-error.component';
import { useAdministrationClient } from '../administration-services.provider';
import { useI18n } from '../../../i18n/i18n.provider';

/** The API stores the lower-case form (ADR 0020); a malformed address is stopped before any request. */
const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** `account.provision`: the person signs in with the Google account of this email within 7 days. */
export function AccountProvision() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [added, setAdded] = useState(false);
  const provision = useMutation({
    mutationFn: (email: string) => administration.provision(email),
    onSuccess: async () => {
      setValue('');
      setAdded(true);
      await queryClient.invalidateQueries({ queryKey: [namespace, 'administration', 'accounts'] });
    },
  });
  const submit = () => {
    const parsed = emailSchema.safeParse(value);
    setInvalid(!parsed.success);
    setAdded(false);
    if (parsed.success) provision.mutate(parsed.data);
  };
  return (
    <Card padding="lg">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Stack gap="md">
          <Title order={2} size="h4">
            {t('administration.accounts.provision.title')}
          </Title>
          <Text size="sm" c="dimmed">
            {t('administration.accounts.provision.hint')}
          </Text>
          <MutationError error={provision.error} />
          {added && (
            <Text size="sm" role="status">
              {t('administration.accounts.provision.done')}
            </Text>
          )}
          <Group align="flex-start" wrap="wrap">
            <TextInput
              flex={1}
              miw={240}
              type="email"
              label={t('administration.accounts.field.email')}
              value={value}
              maxLength={254}
              withAsterisk
              error={invalid ? t('administration.accounts.emailInvalid') : undefined}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            <Button
              type="submit"
              mt={25}
              loading={provision.isPending}
              leftSection={<IconUserPlus size={18} stroke={1.75} aria-hidden />}
            >
              {t('administration.accounts.provision.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

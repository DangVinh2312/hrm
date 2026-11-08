import {
  Button,
  Card,
  Group,
  Select,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconUserPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '../../auth/session.provider';
import { MutationError } from '../../account/components/mutation-error.component';
import { useAdministrationClient } from '../administration-services.provider';
import { emailSchema } from '../account-email.helper';
import { useI18n } from '../../../i18n/i18n.provider';

/**
 * `account.provision`: the person signs in with the Google account of this email within 7 days.
 * Every account holds a role: the roles to choose from are the ones `role.read` returns;
 * without that read no account can be added.
 */
export function AccountProvision() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [roleKey, setRoleKey] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [roleMissing, setRoleMissing] = useState(false);
  const [added, setAdded] = useState(false);
  const catalog = useQuery({
    queryKey: [namespace, 'administration', 'roles'],
    queryFn: ({ signal }) => administration.roles(signal),
  });
  const provision = useMutation({
    mutationFn: (input: { email: string; roleKey: string }) =>
      administration.provision(input.email, input.roleKey),
    onSuccess: async () => {
      setValue('');
      setRoleKey(null);
      setAdded(true);
      await queryClient.invalidateQueries({ queryKey: [namespace, 'administration', 'accounts'] });
    },
  });
  const submit = () => {
    const parsed = emailSchema.safeParse(value);
    setInvalid(!parsed.success);
    setRoleMissing(roleKey === null);
    setAdded(false);
    if (parsed.success && roleKey !== null) provision.mutate({ email: parsed.data, roleKey });
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
          {catalog.isError && (
            <Text size="sm" c="dimmed">
              {t('administration.accounts.provision.rolesUnavailable')}
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
            {catalog.isPending ? (
              <Skeleton
                flex={1}
                miw={200}
                height={36}
                mt={25}
                radius="md"
                aria-busy="true"
                aria-label={t('common.loading')}
              />
            ) : (
              <Select
                flex={1}
                miw={200}
                searchable
                allowDeselect={false}
                withAsterisk
                disabled={!catalog.data}
                label={t('administration.accounts.field.role')}
                data={(catalog.data?.roles ?? []).map((role) => ({
                  value: role.key,
                  label: role.label || role.key,
                }))}
                value={roleKey}
                error={
                  roleMissing ? t('administration.accounts.provision.roleRequired') : undefined
                }
                onChange={(next) => {
                  setRoleMissing(false);
                  setRoleKey(next);
                }}
              />
            )}
            <Button
              type="submit"
              mt={25}
              disabled={!catalog.data}
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

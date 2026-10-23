import { Badge, Button, Card, Group, Select, Stack, Text, Title } from '@mantine/core';
import { IconLink, IconLinkOff } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '../../auth/session.provider';
import { MutationError } from '../../account/components/mutation-error.component';
import { useEmployeeClient } from '../employee-services.provider';
import { useI18n } from '../../../i18n/i18n.provider';
import type { Employee } from '../employee.client';
import { useEmployeeRefresh } from './employee-profile.component';

/**
 * Account link (employee.linkAccount: fresh auth, boundary required — Root today). Controls appear
 * only when the account list itself is readable (account.read); otherwise just the status shows.
 */
export function EmployeeAccountSection(props: { readonly employee: Employee }) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const employees = useEmployeeClient();
  const refresh = useEmployeeRefresh();
  const { employee } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const accounts = useQuery({
    queryKey: [namespace, 'accounts', 'options'],
    queryFn: ({ signal }) => employees.accounts(signal),
    retry: false,
  });
  const link = useMutation({
    mutationFn: (accountId: string | null) =>
      employees.linkAccount(employee.id, { expectedVersion: employee.version, accountId }),
    onSuccess: async () => {
      setSelected(null);
      await refresh();
    },
  });
  const linked = accounts.data?.find((account) => account.userId === employee.accountId);
  const options = (accounts.data ?? [])
    .filter((account) => account.state !== 'suspended' && account.userId !== employee.accountId)
    .map((account) => ({ value: account.userId, label: account.email ?? account.userId }));

  return (
    <Card padding="lg">
      <Stack gap="md">
        <Group gap="xs">
          <IconLink size={20} stroke={1.75} aria-hidden />
          <Title order={2}>{t('employee.account.title')}</Title>
        </Group>
        <Group gap="sm">
          <Badge color={employee.accountId ? 'green' : 'gray'} variant="light">
            {t(employee.accountId ? 'employee.account.linked' : 'employee.account.notLinked')}
          </Badge>
          {linked?.email && <Text size="sm">{linked.email}</Text>}
        </Group>
        {accounts.isSuccess && (
          <Stack gap="sm">
            <MutationError error={link.error} />
            <Text size="sm" c="dimmed">
              {t('employee.account.hint')}
            </Text>
            <Group align="flex-end" wrap="wrap">
              <Select
                flex={1}
                miw={240}
                label={t('employee.account.select')}
                data={options}
                value={selected}
                onChange={setSelected}
                searchable
                clearable
                nothingFoundMessage={t('employee.account.noOption')}
              />
              <Button
                leftSection={<IconLink size={18} stroke={1.75} aria-hidden />}
                disabled={selected === null}
                loading={link.isPending && link.variables !== null}
                onClick={() => {
                  if (selected) link.mutate(selected);
                }}
              >
                {t('employee.account.link')}
              </Button>
              {employee.accountId && (
                <Button
                  variant="subtle"
                  color="red"
                  leftSection={<IconLinkOff size={18} stroke={1.75} aria-hidden />}
                  loading={link.isPending && link.variables === null}
                  onClick={() => link.mutate(null)}
                >
                  {t('employee.account.unlink')}
                </Button>
              )}
            </Group>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

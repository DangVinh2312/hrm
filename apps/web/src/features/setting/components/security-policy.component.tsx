import { Card, Stack, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { QueryState } from '../../../components/query-state.component';
import { useI18n } from '../../../i18n/i18n.provider';
import { useSession } from '../../auth/session.provider';
import { useSettingClient } from '../setting-services.provider';
import type { SecurityPolicy } from '../setting.client';
import type { MessageKey } from '../../../i18n/i18n.helper';

const rows = [
  [
    'freshAuthenticationSeconds',
    'setting.security.freshAuthenticationSeconds',
    'setting.unit.seconds',
  ],
  ['sessionHours', 'setting.security.sessionHours', 'setting.unit.hours'],
  ['rateLimitWindowMinutes', 'setting.security.rateLimitWindowMinutes', 'setting.unit.minutes'],
  ['oidcAttemptMinutes', 'setting.security.oidcAttemptMinutes', 'setting.unit.minutes'],
  ['idleMinutes', 'setting.security.idleMinutes', 'setting.unit.minutes'],
] as const satisfies readonly (readonly [keyof SecurityPolicy, MessageKey, MessageKey])[];

/**
 * The session and sign-in timings in force, from the API's one policy. View only by design:
 * no input, no secret and no key; changing a value is a release.
 */
export function SecurityPolicyView() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const client = useSettingClient();
  const security = useQuery({
    queryKey: [namespace, 'setting', 'security'],
    queryFn: ({ signal }) => client.security(signal),
  });
  return (
    <Card padding="lg">
      <QueryState
        pending={security.isPending}
        error={security.error}
        onRetry={() => security.refetch()}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('setting.security.description')}
          </Text>
          <Table verticalSpacing="sm" aria-label={t('setting.security.title')}>
            <Table.Tbody>
              {rows.map(([field, label, unit]) => (
                <Table.Tr key={field}>
                  <Table.Th scope="row" fw={500}>
                    {t(label)}
                  </Table.Th>
                  <Table.Td>{`${security.data?.[field] ?? ''} ${t(unit)}`}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      </QueryState>
    </Card>
  );
}

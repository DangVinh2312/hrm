import { Alert, Badge, Card, Code, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { QueryState } from '../../components/query-state.component';
import { useI18n } from '../../i18n/i18n.provider';
import { useMenus } from '../auth/me.provider';
import { useSession } from '../auth/session.provider';
import { useAdministrationClient } from './administration-services.provider';
import { GrantGroups } from './components/grant-groups.component';

/**
 * Role matrix (ADR 0041 §3, ADR 0046), read only: every role, whether the release or the system
 * owns it, how many accounts hold it, and its permissions grouped by resource. The menu `roles`
 * is a display hint from the server: without it the page is "not found" and asks for nothing; the
 * API authorizes the read itself. There is no control that changes anything on this page.
 */
export function RolePage() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const menus = useMenus();
  const allowed = menus.data?.menus.includes('roles') === true;
  const matrix = useQuery({
    queryKey: [namespace, 'administration', 'roles'],
    enabled: allowed,
    queryFn: ({ signal }) => administration.roles(signal),
  });

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('administration.roles.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('administration.roles.description')}
        </Text>
      </div>
      <QueryState pending={menus.isPending} error={menus.error} onRetry={() => menus.refetch()}>
        {!allowed ? (
          <Alert
            color="gray"
            title={t('notFound.title')}
            icon={<IconAlertCircle size={18} aria-hidden />}
          >
            {t('notFound.body')}
          </Alert>
        ) : (
          <QueryState
            pending={matrix.isPending}
            error={matrix.error}
            onRetry={() => matrix.refetch()}
          >
            {matrix.data?.roles.length === 0 ? (
              <Text c="dimmed">{t('administration.roles.empty')}</Text>
            ) : (
              <Stack gap="md" aria-label={t('administration.roles.listLabel')}>
                {matrix.data?.roles.map((role) => (
                  <Card
                    key={role.key}
                    component="section"
                    padding="lg"
                    aria-label={role.label || role.key}
                  >
                    <Stack gap="sm">
                      <Group justify="space-between" align="flex-start" wrap="wrap">
                        <div>
                          <Title order={2} size="h4">
                            {role.label || role.key}
                          </Title>
                          <Code>{role.key}</Code>
                        </div>
                        <Group gap="xs">
                          <Badge variant="light" color="gray" tt="none">
                            {t(`administration.roles.source.${role.source}`)}
                          </Badge>
                          <Text size="sm" c="dimmed">
                            {t('administration.roles.holders')}: {role.holders}
                          </Text>
                        </Group>
                      </Group>
                      {role.grants.length === 0 ? (
                        <Text size="sm" c="dimmed">
                          {t('administration.roles.noGrants')}
                        </Text>
                      ) : (
                        <GrantGroups grants={role.grants} />
                      )}
                    </Stack>
                  </Card>
                ))}
              </Stack>
            )}
          </QueryState>
        )}
      </QueryState>
    </Stack>
  );
}

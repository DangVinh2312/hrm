import { Alert, Badge, Button, Card, Code, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle, IconPencil, IconPlus } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryState } from '../../components/query-state.component';
import { useI18n } from '../../i18n/i18n.provider';
import { useMenus } from '../auth/me.provider';
import { useSession } from '../auth/session.provider';
import { useAdministrationClient } from './administration-services.provider';
import { GrantGroups } from './components/grant-groups.component';
import { RoleCapabilities } from './components/role-capabilities.component';
import { RoleDelete } from './components/role-delete.component';
import { RoleForm, type RoleSaved } from './components/role-form.component';
import type { RoleRow } from './administration.client';
import { isEditableRole } from './role-form.helper';

/**
 * Role matrix: every role, whether the release or the system
 * owns it, how many accounts hold it, and its permissions grouped by resource. The menu `roles`
 * is a display hint from the server: without it the page is "not found" and asks for nothing; the
 * API authorizes the read itself. Only a runtime role has controls (edit, delete); the buttons
 * are hints, the API authorizes every write.
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

  const [form, setForm] = useState<RoleRow | 'new' | null>(null);
  const [notice, setNotice] = useState<RoleSaved | 'stale' | null>(null);

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Title order={1}>{t('administration.roles.title')}</Title>
          <Text c="dimmed" mt={4}>
            {t('administration.roles.description')}
          </Text>
        </div>
        {allowed && matrix.data && (
          <Button
            leftSection={<IconPlus size={16} stroke={1.75} aria-hidden />}
            onClick={() => {
              setNotice(null);
              setForm('new');
            }}
          >
            {t('administration.roles.create')}
          </Button>
        )}
      </Group>
      {notice === 'stale' && (
        <Alert color="yellow" role="alert" icon={<IconAlertCircle size={18} aria-hidden />}>
          {t('administration.roles.edit.stale')}
        </Alert>
      )}
      {(notice === 'create' || notice === 'update') && (
        <Text size="sm" role="status">
          {t(`administration.roles.${notice}.done`)}
        </Text>
      )}
      {form !== null && matrix.data && (
        <RoleForm
          role={form === 'new' ? undefined : form}
          catalog={matrix.data.catalog}
          onClose={() => setForm(null)}
          onSaved={(kind) => {
            setForm(null);
            setNotice(kind);
          }}
          onStale={() => {
            setForm(null);
            setNotice('stale');
          }}
        />
      )}
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
            {matrix.data?.truncated === true && (
              <Alert color="yellow" role="status" icon={<IconAlertCircle size={18} aria-hidden />}>
                {t('administration.roles.truncated')}
              </Alert>
            )}
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
                      <RoleCapabilities capabilities={role.capabilities} />
                      {role.source === 'runtime' && (
                        <Group gap="sm" align="flex-start" wrap="wrap">
                          {isEditableRole(role) ? (
                            !matrix.data?.truncated && (
                              <Button
                                size="xs"
                                variant="light"
                                aria-label={`${t('administration.roles.edit')} ${role.label || role.key}`}
                                leftSection={<IconPencil size={16} stroke={1.75} aria-hidden />}
                                onClick={() => {
                                  setNotice(null);
                                  setForm(role);
                                }}
                              >
                                {t('administration.roles.edit')}
                              </Button>
                            )
                          ) : (
                            <Text size="xs" c="dimmed">
                              {t('administration.roles.edit.unsupported')}
                            </Text>
                          )}
                          <RoleDelete role={role} />
                        </Group>
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

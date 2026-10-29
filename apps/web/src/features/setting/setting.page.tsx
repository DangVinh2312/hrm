import { Alert, Card, Divider, Stack, Tabs, Text, Title } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { QueryState } from '../../components/query-state.component';
import { useI18n } from '../../i18n/i18n.provider';
import { useMenus } from '../auth/me.provider';
import { useSession } from '../auth/session.provider';
import { SecurityPolicyView } from './components/security-policy.component';
import { SettingField } from './components/setting-field.component';
import { SettingHistory } from './components/setting-history.component';
import type { SettingGroup, SettingRow } from './setting.client';
import { isKnownSetting, settingLabelStems } from './setting.helper';
import { useSettingClient } from './setting-services.provider';

/**
 * Settings: HR rules and company information (editable per group by the
 * permission the API checks) and the session timings (view only). The menu `settings` is a display
 * hint from the server: without it the page is "not found" and asks for nothing.
 */
export function SettingPage() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const client = useSettingClient();
  const menus = useMenus();
  const allowed = menus.data?.menus.includes('settings') === true;
  const [historyOf, setHistoryOf] = useState<SettingRow | undefined>();
  const list = useQuery({
    queryKey: [namespace, 'setting', 'list'],
    enabled: allowed,
    queryFn: ({ signal }) => client.list(signal),
  });
  const group = (name: SettingGroup) =>
    (list.data?.settings ?? []).filter((row) => row.group === name && isKnownSetting(row.key));

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('setting.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('setting.description')}
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
          <Tabs defaultValue="rule" keepMounted={false}>
            <Tabs.List aria-label={t('setting.tabs')}>
              <Tabs.Tab value="rule">{t('setting.tab.rule')}</Tabs.Tab>
              <Tabs.Tab value="profile">{t('setting.tab.profile')}</Tabs.Tab>
              <Tabs.Tab value="security">{t('setting.tab.security')}</Tabs.Tab>
            </Tabs.List>
            {(['rule', 'profile'] as const).map((name) => (
              <Tabs.Panel key={name} value={name} pt="md">
                <Card padding="lg">
                  <QueryState
                    pending={list.isPending}
                    error={list.error}
                    onRetry={() => list.refetch()}
                  >
                    {list.data?.canUpdate[name] === false && (
                      <Text size="sm" c="dimmed" mb="sm">
                        {t('setting.readOnly')}
                      </Text>
                    )}
                    {group(name).map((row, index) => (
                      <Fragment key={row.key}>
                        {index > 0 && <Divider />}
                        <SettingField
                          row={row}
                          stem={settingLabelStems[row.key as keyof typeof settingLabelStems]}
                          editable={list.data?.canUpdate[name] === true}
                          onHistory={() => setHistoryOf(row)}
                        />
                      </Fragment>
                    ))}
                  </QueryState>
                </Card>
              </Tabs.Panel>
            ))}
            <Tabs.Panel value="security" pt="md">
              <SecurityPolicyView />
            </Tabs.Panel>
          </Tabs>
        )}
      </QueryState>
      {historyOf && isKnownSetting(historyOf.key) && (
        <SettingHistory
          settingKey={historyOf.key}
          label={t(`${settingLabelStems[historyOf.key]}.label`)}
          onClose={() => setHistoryOf(undefined)}
        />
      )}
    </Stack>
  );
}

import { Card, Group, Stack, Text, Title } from '@mantine/core';
import { QueryState } from '../../components/query-state.component';
import { useI18n } from '../../i18n/i18n.provider';
import { useOwnAccount } from './account.helper';
import { LinkedIdentityList } from './components/linked-identity-list.component';
import { SecondFactorCard } from './components/second-factor-card.component';

/**
 * "Phương thức đăng nhập": the account's email, its one Google account (display only: no link or
 * unlink) and the two-step verification it manages itself.
 */
export function SignInMethodsPage() {
  const { t } = useI18n();
  const query = useOwnAccount();
  const own = query.data;

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('account.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('account.intro')}
        </Text>
      </div>
      <QueryState
        pending={query.isPending}
        error={query.error}
        onRetry={() => query.refetch()}
        rows={4}
      >
        {own && (
          <Stack gap="lg">
            <Card padding="lg" withBorder>
              <Stack gap="sm">
                <Title order={2} size="h3">
                  {t('account.summary.title')}
                </Title>
                <Group gap="xs">
                  <Text size="sm" c="dimmed">
                    {t('account.summary.email')}
                  </Text>
                  <Text size="sm" fw={600}>
                    {own.email ?? t('account.summary.emailNone')}
                  </Text>
                </Group>
              </Stack>
            </Card>
            <SecondFactorCard mfa={own.mfa} />
            <Card padding="lg" withBorder>
              <LinkedIdentityList identities={own.identities} />
            </Card>
          </Stack>
        )}
      </QueryState>
    </Stack>
  );
}

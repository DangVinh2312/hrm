import { Card, Code, Group, Stack, Text, Title } from '@mantine/core';
import { IconBrandGoogle } from '@tabler/icons-react';
import { useI18n } from '../../i18n/i18n.provider';
import type { LinkedIdentity } from '../account.client';
import { isGoogleIssuer, shortReference } from '../account.helper';

/**
 * The Google account bound to the signed-in user (one per account, ADR 0027 §6); display only.
 * Only the reference's first characters show, never the provider subject.
 */
export function LinkedIdentityList(props: { readonly identities: readonly LinkedIdentity[] }) {
  const { t } = useI18n();
  return (
    <Stack gap="md">
      <Title order={2} size="h3">
        {t('account.google.title')}
      </Title>
      {props.identities.length === 0 ? (
        <Text c="dimmed">{t('account.google.empty')}</Text>
      ) : (
        <Stack gap="sm" component="ul" p={0} m={0} style={{ listStyle: 'none' }}>
          {props.identities.map((identity) => (
            <li key={identity.reference}>
              <Card padding="md" withBorder>
                <Stack gap={4}>
                  <Group gap="xs">
                    <IconBrandGoogle size={20} stroke={1.75} aria-hidden />
                    <Text fw={600}>
                      {isGoogleIssuer(identity.issuer)
                        ? t('account.provider.google')
                        : identity.issuer}
                    </Text>
                  </Group>
                  <Group gap={6}>
                    <Text size="sm" c="dimmed">
                      {t('account.reference')}
                    </Text>
                    <Code>{shortReference(identity.reference)}</Code>
                  </Group>
                </Stack>
              </Card>
            </li>
          ))}
        </Stack>
      )}
      <Text size="sm" c="dimmed">
        {t('account.google.change')}
      </Text>
    </Stack>
  );
}

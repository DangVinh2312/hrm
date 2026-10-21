import { Anchor, Card, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconId, IconLock, IconUserCheck } from '@tabler/icons-react';
import { Link } from 'react-router';
import { useHrMe } from '../../hr/hr-services.provider';
import { useI18n } from '../../../i18n/i18n.provider';

/** Overview of a signed-in user. Personal widgets arrive with their features (T3+), never as mock data. */
export function HomePage() {
  const { t } = useI18n();
  const me = useHrMe();
  const employee = me.data?.employee;
  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('home.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('home.signedIn')}
        </Text>
      </div>
      {employee && (
        <Card padding="lg">
          <Group align="flex-start" wrap="nowrap" gap="md">
            <ThemeIcon size={44} radius="md" variant="light" aria-hidden>
              <IconId size={24} stroke={1.75} />
            </ThemeIcon>
            <Stack gap={4}>
              <Text fw={600}>{t('home.profileTitle')}</Text>
              <Text size="sm">
                {employee.code} · {employee.fullName}
              </Text>
              <Anchor component={Link} to={`/employees/${employee.id}`} size="sm">
                {t('home.profileOpen')}
              </Anchor>
            </Stack>
          </Group>
        </Card>
      )}
      <Card padding="lg">
        <Group align="flex-start" wrap="nowrap" gap="md">
          <ThemeIcon size={44} radius="md" variant="light" aria-hidden>
            <IconUserCheck size={24} stroke={1.75} />
          </ThemeIcon>
          <Stack gap={4}>
            <Text fw={600}>{t('home.accountReadyTitle')}</Text>
            <Text c="dimmed" size="sm">
              {t('home.accountReadyBody')}
            </Text>
          </Stack>
        </Group>
      </Card>
      <Card padding="lg">
        <Group align="flex-start" wrap="nowrap" gap="md">
          <ThemeIcon size={44} radius="md" variant="light" color="gray" aria-hidden>
            <IconLock size={24} stroke={1.75} />
          </ThemeIcon>
          <Stack gap={4}>
            <Text fw={600}>{t('home.rolesTitle')}</Text>
            <Text c="dimmed" size="sm">
              {t('home.rolesBody')}
            </Text>
          </Stack>
        </Group>
      </Card>
    </Stack>
  );
}

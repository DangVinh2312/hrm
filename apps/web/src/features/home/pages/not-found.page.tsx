import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { Link } from 'react-router';
import { useI18n } from '../../../i18n/i18n.provider';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <Center mih="100dvh" p="md" bg="var(--mantine-color-gray-0)">
      <Stack align="center" gap="sm" maw={420} ta="center">
        <Text fw={700} c="brand" size="xl" aria-hidden>
          404
        </Text>
        <Title order={1}>{t('notFound.title')}</Title>
        <Text c="dimmed">{t('notFound.body')}</Text>
        <Button
          component={Link}
          to="/"
          variant="light"
          mt="sm"
          leftSection={<IconArrowLeft size={18} aria-hidden />}
        >
          {t('notFound.home')}
        </Button>
      </Stack>
    </Center>
  );
}

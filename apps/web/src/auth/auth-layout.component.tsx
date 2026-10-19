import { Group, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import {
  IconBuildingCommunity,
  IconChecklist,
  IconClockHour4,
  IconShieldLock,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { MessageKey } from '../i18n/i18n.helper';
import { useI18n } from '../i18n/i18n.provider';
import { LocaleSwitch } from '../i18n/locale-switch.component';
import classes from './auth-layout.module.css';

const features: readonly { readonly icon: typeof IconChecklist; readonly text: MessageKey }[] = [
  { icon: IconChecklist, text: 'auth.brand.featureApprovals' },
  { icon: IconClockHour4, text: 'auth.brand.featureLeave' },
  { icon: IconShieldLock, text: 'auth.brand.featurePrivacy' },
];

/** Signed-out pages: brand panel (desktop only) beside one focused card. */
export function AuthLayout(props: { readonly title: string; readonly children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className={classes.root}>
      <aside className={classes.brand} aria-hidden>
        <Group gap="sm">
          <ThemeIcon size={40} radius="md" variant="white">
            <IconBuildingCommunity size={24} stroke={1.75} />
          </ThemeIcon>
          <Text fw={700} size="xl">
            HRM
          </Text>
        </Group>
        <Stack gap="lg" maw={420}>
          <Title order={2} size="h1" c="white">
            {t('auth.brand.title')}
          </Title>
          <Stack gap="sm">
            {features.map((feature) => (
              <Group key={feature.text} gap="sm" wrap="nowrap" className={classes.feature}>
                <feature.icon size={20} stroke={1.75} />
                <Text>{t(feature.text)}</Text>
              </Group>
            ))}
          </Stack>
        </Stack>
        <Text size="sm" className={classes.feature}>
          {t('auth.brand.audience')}
        </Text>
      </aside>
      <main className={classes.content}>
        <Stack gap="lg" w={440} maw="100%">
          <Group justify="flex-end">
            <LocaleSwitch />
          </Group>
          <Group gap="sm" hiddenFrom="md" justify="center">
            <ThemeIcon size={36} radius="md" aria-hidden>
              <IconBuildingCommunity size={22} stroke={1.75} />
            </ThemeIcon>
            <Text fw={700} size="lg">
              HRM
            </Text>
          </Group>
          <Paper withBorder shadow="sm" p={{ base: 'lg', sm: 'xl' }}>
            <Stack gap="lg">
              <Title order={1}>{props.title}</Title>
              {props.children}
            </Stack>
          </Paper>
        </Stack>
      </main>
    </div>
  );
}

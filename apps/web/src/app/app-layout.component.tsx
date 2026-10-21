import {
  Alert,
  AppShell,
  Box,
  Burger,
  Button,
  Group,
  NavLink,
  ScrollArea,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconBuildingCommunity, IconLogout, IconShieldLock } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { NavLink as RouterNavLink, Outlet } from 'react-router';
import { useSession } from '../features/auth/session.provider';
import { useHrMe } from '../features/hr/hr-services.provider';
import { useI18n } from '../i18n/i18n.provider';
import { LocaleSwitch } from '../i18n/locale-switch.component';
import { visibleNavigation } from './navigation.config';

/**
 * Signed-in shell: header with sign-out, sidebar (drawer below `sm`), routed page in main. Until
 * the menus load (or if they fail) only what every signed-in user has is shown; permissions are
 * never guessed client-side.
 */
export function AppLayout() {
  const { logout } = useSession();
  const { t } = useI18n();
  const [opened, { toggle, close }] = useDisclosure();
  const signOut = useMutation({ mutationFn: () => logout() });
  const me = useHrMe();
  const items = visibleNavigation(me.data?.menus ?? []);

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 248, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={{ base: 'md', sm: 'lg' }}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label={t(opened ? 'app.menu.close' : 'app.menu.open')}
            />
            <ThemeIcon size={32} radius="md" aria-hidden>
              <IconBuildingCommunity size={20} stroke={1.75} />
            </ThemeIcon>
            <Text component="span" fw={700} size="lg">
              HRM
            </Text>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <LocaleSwitch />
            <Button
              variant="subtle"
              color="gray"
              leftSection={<IconLogout size={18} stroke={1.75} aria-hidden />}
              loading={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              {t('app.signOut')}
            </Button>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm" aria-label={t('app.navigation')}>
        <AppShell.Section grow component={ScrollArea}>
          {items.map((item) => (
            <NavLink
              key={item.path}
              component={RouterNavLink}
              to={item.path}
              end={item.path === '/'}
              label={t(item.label)}
              leftSection={<item.icon size={20} stroke={1.75} aria-hidden />}
              onClick={close}
              styles={{ root: { borderRadius: 'var(--mantine-radius-md)' } }}
            />
          ))}
        </AppShell.Section>
        <AppShell.Section>
          {/* Every signed-in user has an account; no server menu is involved. */}
          <NavLink
            component={RouterNavLink}
            to="/account/sign-in-methods"
            label={t('navigation.signInMethods')}
            leftSection={<IconShieldLock size={20} stroke={1.75} aria-hidden />}
            onClick={close}
            styles={{ root: { borderRadius: 'var(--mantine-radius-md)' } }}
          />
          <Text size="xs" c="dimmed" px="sm" py="xs">
            {t('app.navigation.hint')}
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main bg="var(--mantine-color-gray-0)">
        <Box maw={1200} mx="auto">
          {signOut.isError && (
            <Alert color="red" title={t('app.signOut.failedTitle')} mb="md" role="alert">
              {t('app.signOut.failedBody')}
            </Alert>
          )}
          <Outlet />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}

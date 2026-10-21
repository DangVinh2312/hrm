import { Alert, Button, Center, Loader, Stack } from '@mantine/core';
import { Navigate, Outlet } from 'react-router';
import { useI18n } from '../../i18n/i18n.provider';
import { useSession } from './session.provider';

/** UX guard only: every API call is still authorized on the server. */
export function RequireSession() {
  const { session, failed, retry } = useSession();
  const { t } = useI18n();
  if (failed)
    return (
      <Center mih="100vh">
        <Stack align="center">
          <Alert color="red" title={t('session.checkFailedTitle')}>
            {t('session.checkFailedBody')}
          </Alert>
          <Button onClick={retry}>{t('common.retry')}</Button>
        </Stack>
      </Center>
    );
  if (session === undefined)
    return (
      <Center mih="100vh">
        <Loader aria-label={t('common.loading')} />
      </Center>
    );
  if (session === null) return <Navigate to="/login" replace />;
  return <Outlet />;
}

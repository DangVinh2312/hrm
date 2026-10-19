import { Alert, Button, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { Navigate, useSearchParams } from 'react-router';
import { useI18n } from '../i18n/i18n.provider';
import { navigateToExternal } from '../infrastructure/external-navigation.helper';
import { apiErrorKey } from '../infrastructure/http.client';
import { AuthLayout } from './auth-layout.component';
import { GoogleMark } from './google-mark.component';
import { useSession } from './session.provider';

export function LoginPage() {
  const { auth, session } = useSession();
  const { t } = useI18n();
  const [params] = useSearchParams();
  const login = useMutation({
    mutationFn: () => auth.beginLogin(),
    onSuccess: (url) => navigateToExternal(url),
  });
  if (session) return <Navigate to="/" replace />;
  return (
    <AuthLayout title={t('auth.login.title')}>
      <Text c="dimmed">{t('auth.login.intro')}</Text>
      {params.get('error') === 'oidc' && (
        <Alert
          color="red"
          title={t('auth.login.callbackFailedTitle')}
          icon={<IconAlertCircle aria-hidden />}
        >
          {t('auth.login.callbackFailedBody')}
        </Alert>
      )}
      {login.isError && (
        <Alert
          color="red"
          title={t('auth.login.startFailedTitle')}
          icon={<IconAlertCircle aria-hidden />}
        >
          {t(apiErrorKey(login.error))}
        </Alert>
      )}
      <Button
        size="md"
        variant="default"
        fullWidth
        leftSection={<GoogleMark />}
        loading={login.isPending || login.isSuccess}
        onClick={() => login.mutate()}
      >
        {t('auth.login.google')}
      </Button>
    </AuthLayout>
  );
}

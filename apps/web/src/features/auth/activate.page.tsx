import { Alert, Button, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { schemaResolver, useForm } from '@mantine/form';
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';
import { isMessageKey } from '../../i18n/i18n.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { ApiError, apiErrorKey } from '../../infrastructure/http.client';
import { navigateToExternal } from '../../infrastructure/external-navigation.helper';
import { AuthLayout } from './auth-layout.component';
import { GoogleMark } from './google-mark.component';
import { useSession } from './session.provider';

/** Activation secrets are 32 random bytes in base64url (API `newSessionSecret`). Messages are locale keys. */
const tokenSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'auth.activate.tokenInvalid'),
});

/** Reads `#token=…` once. The fragment never reaches the server or its access logs (ADR 0019). */
export function tokenFromHash(hash: string): string {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
  return tokenSchema.safeParse({ token: value }).success ? value : '';
}

export function ActivatePage() {
  const { auth } = useSession();
  const { t } = useI18n();
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: { token: tokenFromHash(window.location.hash) },
    validate: schemaResolver(tokenSchema, { sync: true }),
  });
  // Remove the secret from the address bar and history as soon as it has been read.
  useEffect(() => {
    if (window.location.hash)
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  const activate = useMutation({
    mutationFn: (token: string) => auth.beginActivation(token),
    onSuccess: (url) => navigateToExternal(url),
  });
  const rejected =
    activate.error instanceof ApiError &&
    (activate.error.status === 400 || activate.error.status === 401);

  return (
    <AuthLayout title={t('auth.activate.title')}>
      <form onSubmit={form.onSubmit((values) => activate.mutate(values.token.trim()))} noValidate>
        <Stack gap="lg">
          <Text c="dimmed">{t('auth.activate.intro')}</Text>
          {activate.isError && (
            <Alert
              color="red"
              title={t('auth.activate.failedTitle')}
              icon={<IconAlertCircle aria-hidden />}
            >
              {t(rejected ? 'auth.activate.rejected' : apiErrorKey(activate.error))}
            </Alert>
          )}
          <TextInput
            label={t('auth.activate.tokenLabel')}
            description={t('auth.activate.tokenDescription')}
            autoComplete="off"
            spellCheck={false}
            key={form.key('token')}
            {...form.getInputProps('token')}
            error={isMessageKey(form.errors.token) ? t(form.errors.token) : undefined}
          />
          <Button
            type="submit"
            size="md"
            variant="default"
            fullWidth
            leftSection={<GoogleMark />}
            loading={activate.isPending || activate.isSuccess}
          >
            {t('auth.activate.submit')}
          </Button>
        </Stack>
      </form>
    </AuthLayout>
  );
}

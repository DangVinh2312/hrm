import {
  Alert,
  Button,
  Code,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAlertCircle, IconCopy } from '@tabler/icons-react';
import { QRCodeSVG } from 'qrcode.react';
import { type FormEvent, useState } from 'react';
import type { MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { ApiError, apiErrorKey } from '../../../infrastructure/http.client';
import type { MfaSetup } from '../account.client';
import { isTotpCode } from '../account.helper';

function refusalKey(error: unknown): MessageKey {
  if (error instanceof ApiError && error.status === 401) return 'mfa.setup.rejected';
  if (error instanceof ApiError && error.status === 409) return 'mfa.setup.expired';
  return apiErrorKey(error);
}

/**
 * Enrollment step (ADR 0026 §8, §11): the QR code is drawn in the page from the URI (the secret
 * never leaves the browser again), the same key is shown as text for manual entry, then one code
 * from the app confirms it.
 */
export function TotpSetup(props: {
  readonly setup: MfaSetup;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onConfirm: (code: string) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const valid = isTotpCode(code.trim());
    setInvalid(!valid);
    if (valid) props.onConfirm(code.trim());
  };
  return (
    <Stack gap="md">
      <Text size="sm">{t('mfa.setup.scan')}</Text>
      <Group align="flex-start" gap="lg">
        <Paper withBorder p="xs" radius="sm">
          <QRCodeSVG
            value={props.setup.uri}
            size={176}
            marginSize={1}
            role="img"
            aria-label={t('mfa.setup.qr')}
          />
        </Paper>
        <Stack gap={6} miw={0}>
          <Text size="sm" c="dimmed">
            {t('mfa.setup.key')}
          </Text>
          <Code fz="sm">{props.setup.secret.match(/.{1,4}/g)?.join(' ')}</Code>
          <CopyButton value={props.setup.secret}>
            {({ copied, copy }) => (
              <div>
                <Button
                  size="compact-sm"
                  variant="default"
                  leftSection={<IconCopy size={16} stroke={1.75} aria-hidden />}
                  onClick={copy}
                >
                  {t(copied ? 'mfa.setup.copied' : 'mfa.setup.copyKey')}
                </Button>
              </div>
            )}
          </CopyButton>
        </Stack>
      </Group>
      <form onSubmit={submit} noValidate>
        <Stack gap="sm">
          <TextInput
            label={t('mfa.setup.code')}
            description={t('mfa.setup.codeHint')}
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            maw={240}
            error={invalid ? t('mfa.invalidCode') : undefined}
          />
          <Text size="xs" c="dimmed">
            {t('mfa.setup.otherSessions')}
          </Text>
          {props.error !== undefined && (
            <Alert
              color="red"
              title={t('mfa.setup.failedTitle')}
              icon={<IconAlertCircle size={18} aria-hidden />}
              role="alert"
            >
              {t(refusalKey(props.error))}
            </Alert>
          )}
          <Group gap="sm">
            <Button type="submit" loading={props.pending}>
              {t('mfa.setup.confirm')}
            </Button>
            <Button variant="default" onClick={props.onCancel} disabled={props.pending}>
              {t('common.cancel')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  );
}

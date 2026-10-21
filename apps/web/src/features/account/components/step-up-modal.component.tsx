import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { type FormEvent, useState } from 'react';
import { useSession } from '../../auth/session.provider';
import type { MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { ApiError, apiErrorKey } from '../../../infrastructure/http.client';
import type { MfaProof } from '../account.client';
import { useAccountClient } from '../account-services.provider';
import { isRecoveryCode, isTotpCode, runUnlessExpired, usePrivateAction } from '../account.helper';

function refusalKey(error: unknown): MessageKey {
  if (error instanceof ApiError && error.status === 401) return 'mfa.stepUp.rejected';
  if (error instanceof ApiError && error.status === 409) return 'mfa.stepUp.notEnabled';
  return apiErrorKey(error);
}

/**
 * Step-up by the account's second factor (ADR 0026 §8): a TOTP code, or one recovery code. A
 * refused proof keeps the dialog open; a session that really ended (e.g. the tenth wrong proof
 * in a row) goes to sign-in. The typed proof stays in this component only and is cleared after
 * use. The caller repeats its action itself: nothing is retried automatically.
 */
export function StepUpModal(props: {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly onVerified: () => void;
}) {
  const { t } = useI18n();
  const { auth, expire } = useSession();
  const account = useAccountClient();
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const verify = usePrivateAction((proof: MfaProof) =>
    runUnlessExpired(auth, expire, () => account.verifyMfa(proof)),
  );
  const clear = () => {
    setValue('');
    setInvalid(false);
    setRecovery(false);
    verify.reset();
  };
  const close = () => {
    clear();
    props.onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // The dialog is portalled, but React events still bubble to an enclosing form (an HR edit
    // form shows this dialog): without this, verifying would resubmit that form by itself.
    event.stopPropagation();
    const typed = value.trim();
    const valid = recovery ? isRecoveryCode(typed) : isTotpCode(typed);
    setInvalid(!valid);
    if (!valid) return;
    const result = await verify.run(recovery ? { recoveryCode: typed } : { code: typed });
    if (!result.ok) return;
    clear();
    props.onVerified();
  };
  return (
    <Modal
      opened={props.opened}
      onClose={close}
      title={t('mfa.stepUp.title')}
      closeOnClickOutside={!verify.pending}
      closeOnEscape={!verify.pending}
    >
      <form onSubmit={(event) => void submit(event)} noValidate>
        <Stack gap="md">
          <Text size="sm">{t(recovery ? 'mfa.stepUp.recoveryBody' : 'mfa.stepUp.body')}</Text>
          <TextInput
            label={t(recovery ? 'mfa.stepUp.recoveryCode' : 'mfa.setup.code')}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete={recovery ? 'off' : 'one-time-code'}
            spellCheck={false}
            maxLength={recovery ? 64 : 6}
            error={invalid ? t(recovery ? 'mfa.invalidRecovery' : 'mfa.invalidCode') : undefined}
            data-autofocus
          />
          {verify.error !== undefined && (
            <Alert color="red" icon={<IconAlertCircle size={18} aria-hidden />} role="alert">
              {t(refusalKey(verify.error))}
            </Alert>
          )}
          <div>
            <Button
              variant="subtle"
              size="compact-sm"
              onClick={() => {
                setRecovery(!recovery);
                setValue('');
                setInvalid(false);
                verify.reset();
              }}
            >
              {t(recovery ? 'mfa.stepUp.useApp' : 'mfa.stepUp.useRecovery')}
            </Button>
          </div>
          <Group justify="flex-end">
            <Button variant="default" onClick={close} disabled={verify.pending}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={verify.pending}>
              {t('mfa.stepUp.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

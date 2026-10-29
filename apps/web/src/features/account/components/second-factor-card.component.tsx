import { Alert, Badge, Button, Card, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle, IconCircleCheck, IconShieldLock } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '../../auth/session.provider';
import type { MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { apiErrorKey } from '../../../infrastructure/http.client';
import type { MfaSetup, OwnAccount } from '../account.client';
import { useAccountClient } from '../account-services.provider';
import { needsStepUp, runUnlessExpired, usePrivateAction } from '../account.helper';
import { RecoveryCodes } from './recovery-codes.component';
import { StepUpModal } from './step-up-modal.component';
import { TotpSetup } from './totp-setup.component';

const statusKeys: Readonly<Record<OwnAccount['mfa']['status'], MessageKey>> = {
  none: 'mfa.status.none',
  pending: 'mfa.status.pending',
  enabled: 'mfa.status.enabled',
};

/**
 * "Xác thực 2 lớp" on the sign-in methods page. Enrollment needs only the session
 * (accepted risk); new recovery codes and removal need a step-up, so a 403 opens the
 * code dialog and the user repeats the action. Secret and codes stay in this component's state.
 */
export function SecondFactorCard(props: { readonly mfa: OwnAccount['mfa'] }) {
  const { t } = useI18n();
  const { auth, expire, namespace } = useSession();
  const account = useAccountClient();
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [verified, setVerified] = useState(false);
  const guarded = <T,>(action: () => Promise<T>) => runUnlessExpired(auth, expire, action);
  const start = usePrivateAction(() => guarded(() => account.setupMfa()));
  const confirm = usePrivateAction((code: string) => guarded(() => account.confirmMfa(code)));
  const regenerate = usePrivateAction(() => guarded(() => account.regenerateRecoveryCodes()));
  const remove = usePrivateAction(() => guarded(() => account.removeMfa()));
  const refresh = () => queryClient.invalidateQueries({ queryKey: [namespace, 'account', 'own'] });
  const status = codes ? 'enabled' : props.mfa.status;

  const begin = async () => {
    const result = await start.run();
    if (result.ok) setSetup(result.value);
  };
  const enroll = async (code: string) => {
    const result = await confirm.run(code);
    if (!result.ok) return;
    setSetup(null);
    setCodes(result.value);
  };
  const renew = async () => {
    setVerified(false);
    const result = await regenerate.run();
    if (result.ok) setCodes(result.value);
  };
  const turnOff = async () => {
    setVerified(false);
    const result = await remove.run();
    setConfirmRemove(false);
    if (result.ok) await refresh();
  };
  // A 403 of either step-up action opens the code dialog; the user then repeats the action.
  const stepUpNeeded = needsStepUp(regenerate.error) || needsStepUp(remove.error);
  const failure = [start.error, regenerate.error, remove.error].find(
    (error) => error !== undefined && !needsStepUp(error),
  );

  return (
    <Card padding="lg" withBorder>
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Title order={2} size="h3">
            {t('mfa.title')}
          </Title>
          <Badge color={status === 'enabled' ? 'green' : 'gray'} variant="light">
            {t(statusKeys[status])}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {t('mfa.intro')}
        </Text>
        {failure !== undefined && (
          <Alert color="red" icon={<IconAlertCircle size={18} aria-hidden />} role="alert">
            {t(apiErrorKey(failure))}
          </Alert>
        )}
        {verified && (
          <Alert color="green" icon={<IconCircleCheck size={18} aria-hidden />} role="status">
            {t('mfa.stepUp.done')}
          </Alert>
        )}
        {codes ? (
          <RecoveryCodes
            codes={codes}
            onDone={() => {
              setCodes(null);
              void refresh();
            }}
          />
        ) : setup ? (
          <TotpSetup
            setup={setup}
            pending={confirm.pending}
            error={confirm.error}
            onConfirm={(code) => void enroll(code)}
            onCancel={() => {
              setSetup(null);
              confirm.reset();
              void refresh();
            }}
          />
        ) : status === 'enabled' ? (
          <Stack gap="sm">
            <Group gap="xs">
              <Text size="sm" c="dimmed">
                {t('mfa.codes.remaining')}
              </Text>
              <Text size="sm" fw={600}>
                {props.mfa.recoveryCodesRemaining}
              </Text>
            </Group>
            <Group gap="sm">
              <Button variant="default" loading={regenerate.pending} onClick={() => void renew()}>
                {t('mfa.codes.regenerate')}
              </Button>
              <Button
                color="red"
                variant="light"
                onClick={() => {
                  remove.reset();
                  setConfirmRemove(true);
                }}
              >
                {t('mfa.remove.button')}
              </Button>
            </Group>
          </Stack>
        ) : (
          <div>
            <Button
              leftSection={<IconShieldLock size={18} stroke={1.75} aria-hidden />}
              loading={start.pending}
              onClick={() => void begin()}
            >
              {t('mfa.setup.start')}
            </Button>
          </div>
        )}
      </Stack>
      <Modal
        opened={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={t('mfa.remove.title')}
        closeOnClickOutside={!remove.pending}
        closeOnEscape={!remove.pending}
      >
        <Stack gap="md">
          <Text size="sm">{t('mfa.remove.body')}</Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => setConfirmRemove(false)}
              disabled={remove.pending}
            >
              {t('common.cancel')}
            </Button>
            <Button color="red" loading={remove.pending} onClick={() => void turnOff()}>
              {t('mfa.remove.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <StepUpModal
        opened={stepUpNeeded}
        onClose={() => {
          regenerate.reset();
          remove.reset();
        }}
        onVerified={() => {
          regenerate.reset();
          remove.reset();
          setVerified(true);
        }}
      />
    </Card>
  );
}

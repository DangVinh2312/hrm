import { Anchor, Button, Text } from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../../../i18n/i18n.provider';
import { useOwnAccount } from '../account.helper';
import { StepUpModal } from './step-up-modal.component';

/**
 * What a refused step-up action offers. An account with a second
 * factor steps up by its code; any other account is pointed to the setup, since nothing else
 * makes a session fresh. Which applies comes from the account's own status, never from the
 * refusal itself: the API answers every refusal alike.
 */
export function StepUpAction() {
  const { t } = useI18n();
  const own = useOwnAccount();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  if (own.data?.mfa.status === 'enabled')
    return (
      <>
        <div>
          <Button
            size="sm"
            variant="default"
            leftSection={<IconShieldLock size={18} stroke={1.75} aria-hidden />}
            onClick={() => {
              setDone(false);
              setOpen(true);
            }}
          >
            {t('mfa.stepUp.open')}
          </Button>
        </div>
        {done && (
          <Text size="sm" role="status">
            {t('mfa.stepUp.done')}
          </Text>
        )}
        <StepUpModal
          opened={open}
          onClose={() => setOpen(false)}
          onVerified={() => {
            setOpen(false);
            setDone(true);
          }}
        />
      </>
    );
  return (
    <Anchor component={Link} to="/account/sign-in-methods" size="sm">
      {t('mfa.setup.start')}
    </Anchor>
  );
}

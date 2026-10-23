import { Alert, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n/i18n.provider';
import { ApiError, apiErrorKey } from '../infrastructure/http.client';

/**
 * Failure of a write. Changes to identity data, leave rates and team assignments need a
 * step-up from the last 5 minutes (ADR 0016 TD5): the API answers those with the same 403 as a
 * missing permission, so a 403 offers a step-up without claiming which — the two-step code for an
 * account with a second factor, else the way to set one up (ADR 0026, ADR 0027 §7).
 * A network failure says the outcome is unknown (design system §4).
 */
export function MutationAlert(props: {
  readonly error: unknown;
  /** The account has a second factor (picks the wording of a 403). */
  readonly secondFactor?: boolean;
  /** Offered on a 403 only; the owner of the account flow supplies it, this component knows no feature. */
  readonly stepUp?: ReactNode;
}) {
  const { t } = useI18n();
  const secondFactor = props.secondFactor === true;
  if (!props.error) return null;
  const denied = props.error instanceof ApiError && props.error.status === 403;
  const conflict = props.error instanceof ApiError && props.error.status === 409;
  const unknown = !(props.error instanceof ApiError);
  return (
    <Alert
      color="red"
      title={t(denied ? 'hr.write.deniedTitle' : 'hr.write.failedTitle')}
      icon={<IconAlertCircle size={18} aria-hidden />}
      role="alert"
    >
      <Stack gap="sm">
        <Text size="sm">
          {t(
            denied
              ? secondFactor
                ? 'hr.write.deniedBodyMfa'
                : 'hr.write.deniedBody'
              : conflict
                ? props.error instanceof ApiError && props.error.code === 'error.periodClosed'
                  ? 'error.periodClosed'
                  : 'hr.write.conflict'
                : unknown
                  ? 'hr.write.unknown'
                  : apiErrorKey(props.error),
          )}
        </Text>
        {denied && props.stepUp}
      </Stack>
    </Alert>
  );
}

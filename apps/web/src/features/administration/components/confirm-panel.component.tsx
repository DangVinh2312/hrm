import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { MutationError } from '../../account/components/mutation-error.component';
import { useI18n } from '../../../i18n/i18n.provider';
import { ApiError } from '../../../infrastructure/http.client';
import type { MessageKey } from '../../../i18n/i18n.helper';

const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;

/** Confirmation step shown in place, inside a dialog that is already open. */
export function ConfirmPanel(props: {
  readonly title: MessageKey;
  readonly body: MessageKey;
  readonly confirm: MessageKey;
  readonly subject?: string;
  /** Page-specific text for a 409, shown instead of the shared conflict wording. */
  readonly conflict?: MessageKey;
  readonly loading: boolean;
  readonly error: unknown;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <Alert color="red" variant="light" role="group" aria-label={t(props.title)}>
      <Stack gap="sm">
        <Text fw={600}>{t(props.title)}</Text>
        <Text size="sm">{t(props.body)}</Text>
        {props.subject !== undefined && (
          <Text size="sm" fw={600}>
            {props.subject}
          </Text>
        )}
        {props.conflict !== undefined && isConflict(props.error) ? (
          <Text size="sm" role="alert">
            {t(props.conflict)}
          </Text>
        ) : (
          <MutationError error={props.error} />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onCancel}>
            {t('common.cancel')}
          </Button>
          <Button color="red" loading={props.loading} onClick={props.onConfirm}>
            {t(props.confirm)}
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}

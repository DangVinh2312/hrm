import { Alert, Button, Group, Skeleton, Stack } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/i18n.provider';
import { ApiError, apiErrorKey } from '../../infrastructure/http.client';

/**
 * Loading and failure states of a read (design system §4): skeleton while loading, a red alert
 * with "Thử lại" on failure; 404 and "not allowed" share the same "Không tìm thấy" message.
 */
export function QueryState(props: {
  readonly pending: boolean;
  readonly error: unknown;
  /** A query refetch: its failure shows through the query state itself. */
  readonly onRetry: () => Promise<unknown>;
  readonly rows?: number;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  if (props.pending)
    return (
      <Stack gap="xs" aria-busy="true" aria-label={t('common.loading')}>
        {Array.from({ length: props.rows ?? 3 }, (_, index) => (
          <Skeleton key={index} height={36} radius="md" />
        ))}
      </Stack>
    );
  if (props.error) {
    const notFound = props.error instanceof ApiError && props.error.status === 404;
    return (
      <Alert
        color={notFound ? 'gray' : 'red'}
        title={t(notFound ? 'notFound.title' : 'hr.loadFailed')}
        icon={<IconAlertCircle size={18} aria-hidden />}
        role="alert"
      >
        <Stack gap="sm">
          {t(notFound ? 'notFound.body' : apiErrorKey(props.error))}
          {!notFound && (
            <Group>
              <Button
                size="xs"
                variant="light"
                color="red"
                onClick={() => {
                  props.onRetry().catch(() => undefined);
                }}
              >
                {t('common.retry')}
              </Button>
            </Group>
          )}
        </Stack>
      </Alert>
    );
  }
  return <>{props.children}</>;
}

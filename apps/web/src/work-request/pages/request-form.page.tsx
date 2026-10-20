import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { IconAlertCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '../../auth/session.provider';
import { BusinessDateInput } from '../../hr/components/business-date-input.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { isMessageKey } from '../../i18n/i18n.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { ApiError, apiErrorKey } from '../../infrastructure/http.client';
import type { SubmitInput } from '../work-request.client';
import {
  MAX_REQUEST_DAYS,
  requestFormSchema,
  toSubmitInput,
  type RequestFormValues,
} from '../work-request-form.schema';
import { isLeave, kindKeys, leaveSlots, minuteLabel, requestKinds } from '../work-request.helper';

const emptyRow = { date: '', slot: '' };

/**
 * New own request (T5). The form only hints (required fields, duplicates); the API decides every
 * rule and an answer shows by its `error.*` key. One idempotency key per distinct content: a retry
 * of the same submit (e.g. after a lost connection) reuses it, an edited form gets a new one.
 */
export function RequestFormPage() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const { workRequest } = useHrServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const attempt = useRef<{ readonly body: string; readonly key: string } | undefined>(undefined);
  const form = useForm<RequestFormValues>({
    initialValues: { kind: 'late-arrival', date: '', time: '', reason: '', rows: [emptyRow] },
    validate: schemaResolver(requestFormSchema, { sync: true }),
  });
  const submit = useMutation({
    mutationFn: (input: SubmitInput) => {
      const body = JSON.stringify(input);
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      return workRequest.submit(input, attempt.current.key);
    },
    onSuccess: async (result) => {
      attempt.current = undefined;
      await queryClient.invalidateQueries({ queryKey: [namespace, 'requests'] });
      await navigate(`/requests/${result.id}`);
    },
  });
  const { kind } = form.values;
  const rows = isLeave(kind) || kind === 'wfh';
  const error = (path: string) => {
    const message: unknown = form.errors[path];
    return isMessageKey(message) ? t(message) : undefined;
  };
  const failure =
    submit.error instanceof ApiError
      ? submit.error.status === 409
        ? 'request.form.conflict'
        : apiErrorKey(submit.error)
      : submit.error
        ? 'request.form.unknown'
        : undefined;

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('request.form.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('request.form.description')}
        </Text>
      </div>
      <Card padding="lg">
        <form onSubmit={form.onSubmit((values) => submit.mutate(toSubmitInput(values)))} noValidate>
          <Stack gap="md">
            {failure && (
              <Alert
                color="red"
                title={t('request.form.failedTitle')}
                icon={<IconAlertCircle size={18} aria-hidden />}
                role="alert"
              >
                {t(failure)}
              </Alert>
            )}
            <Select
              label={t('request.field.kind')}
              withAsterisk
              allowDeselect={false}
              data={requestKinds.map((value) => ({ value, label: t(kindKeys[value]) }))}
              {...form.getInputProps('kind')}
            />
            {(kind === 'late-arrival' || kind === 'early-departure') && (
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <BusinessDateInput
                  label={t('request.field.date')}
                  withAsterisk
                  {...form.getInputProps('date')}
                  error={error('date')}
                />
                <TextInput
                  type="time"
                  label={t(
                    kind === 'late-arrival'
                      ? 'request.field.expectedArrival'
                      : 'request.field.expectedDeparture',
                  )}
                  withAsterisk
                  {...form.getInputProps('time')}
                  error={error('time')}
                />
              </SimpleGrid>
            )}
            {rows && (
              <Stack gap="sm">
                {form.values.rows.map((_, index) => (
                  <Group key={index} align="flex-start" wrap="nowrap">
                    <SimpleGrid cols={{ base: 1, sm: isLeave(kind) ? 2 : 1 }} flex={1}>
                      <BusinessDateInput
                        label={`${t('request.field.date')} ${index + 1}`}
                        withAsterisk
                        {...form.getInputProps(`rows.${index}.date`)}
                        error={error(`rows.${index}.date`)}
                      />
                      {isLeave(kind) && (
                        <Select
                          label={`${t('request.field.slot')} ${index + 1}`}
                          withAsterisk
                          data={leaveSlots.map((slot) => ({
                            value: slot.value,
                            label: `${minuteLabel(slot.start)}–${minuteLabel(slot.end)}`,
                          }))}
                          {...form.getInputProps(`rows.${index}.slot`)}
                          error={error(`rows.${index}.slot`)}
                        />
                      )}
                    </SimpleGrid>
                    {form.values.rows.length > 1 && (
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="lg"
                        mt={25}
                        aria-label={`${t('request.form.removeDate')} ${index + 1}`}
                        onClick={() => form.removeListItem('rows', index)}
                      >
                        <IconTrash size={18} stroke={1.75} aria-hidden />
                      </ActionIcon>
                    )}
                  </Group>
                ))}
                {error('rows') && (
                  <Text size="sm" c="red">
                    {error('rows')}
                  </Text>
                )}
                <Group>
                  <Button
                    variant="light"
                    leftSection={<IconPlus size={18} stroke={1.75} aria-hidden />}
                    disabled={form.values.rows.length >= MAX_REQUEST_DAYS}
                    onClick={() => form.insertListItem('rows', emptyRow)}
                  >
                    {t('request.form.addDate')}
                  </Button>
                </Group>
                {isLeave(kind) && (
                  <Text size="sm" c="dimmed">
                    {t('request.form.slotHint')}
                  </Text>
                )}
              </Stack>
            )}
            <TextInput
              label={t('request.field.reason')}
              withAsterisk
              maxLength={1000}
              {...form.getInputProps('reason')}
              error={error('reason')}
            />
            <Group justify="flex-end">
              <Button type="submit" loading={submit.isPending}>
                {t('request.form.submit')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}

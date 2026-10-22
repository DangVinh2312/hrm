import { Alert, Button, Group, NumberInput, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { IconAlertCircle } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { z } from 'zod';
import { useSession } from '../auth/session.provider';
import { MutationError } from '../hr/components/mutation-error.component';
import { useHrServices } from '../hr/hr-services.provider';
import { isMessageKey } from '../../i18n/i18n.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { ApiError } from '../../infrastructure/http.client';
import type { AdjustmentInput } from './attendance.client';
import { MAX_ADJUSTMENT_MINUTES, referencePattern } from './attendance.helper';

/** Mirrors the API validator (messages are locale keys); the API still validates everything. */
const adjustSchema = z.object({
  workDate: z.iso.date('attendance.adjust.dateInvalid'),
  minutes: z
    .number('attendance.adjust.minutesInvalid')
    .int('attendance.adjust.minutesInvalid')
    .min(-MAX_ADJUSTMENT_MINUTES, 'attendance.adjust.minutesInvalid')
    .max(MAX_ADJUSTMENT_MINUTES, 'attendance.adjust.minutesInvalid')
    .refine((value) => value !== 0, 'attendance.adjust.minutesInvalid'),
  reason: z
    .string()
    .trim()
    .min(1, 'attendance.adjust.reasonRequired')
    .max(300, 'attendance.adjust.reasonRequired'),
  reference: z
    .string()
    .trim()
    .refine(
      (value) => value === '' || referencePattern.test(value),
      'attendance.adjust.referenceInvalid',
    ),
});
/** `minutes` is empty text until the person types a number (NumberInput's own empty value). */
type Values = Omit<z.input<typeof adjustSchema>, 'minutes'> & { minutes: number | string };

/**
 * Add one adjustment. One idempotency key per distinct content: a retry after a lost answer or a
 * refusal reuses it; changed content gets a new one. A 409 other than `error.periodClosed` means
 * the day is outside the employment period or the month's total would go below zero: said in the
 * page's own words, and the shown month is reloaded.
 */
export function AttendanceAdjustForm(props: {
  readonly employeeId: string;
  readonly month: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const { attendance } = useHrServices();
  const queryClient = useQueryClient();
  const attempt = useRef<{ readonly body: string; readonly key: string } | undefined>(undefined);
  const form = useForm<Values>({
    mode: 'uncontrolled',
    initialValues: { workDate: '', minutes: '', reason: '', reference: '' },
    validate: schemaResolver(adjustSchema, { sync: true }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: [namespace, 'attendance'] });
  const add = useMutation({
    mutationFn: (values: Values) => {
      const parsed = adjustSchema.parse(values);
      const input: AdjustmentInput = {
        workDate: parsed.workDate,
        minutes: parsed.minutes,
        reason: parsed.reason,
        ...(parsed.reference === '' ? {} : { reference: parsed.reference }),
      };
      const body = JSON.stringify([props.employeeId, input]);
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      return attendance.adjust(props.employeeId, input, attempt.current.key);
    },
    onSuccess: async () => {
      attempt.current = undefined;
      await refresh();
      props.onClose();
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409 && error.code !== 'error.periodClosed')
        await refresh();
    },
  });
  const field = (name: keyof Values) => {
    const input = form.getInputProps(name);
    const error: unknown = input.error;
    return { ...input, error: isMessageKey(error) ? t(error) : undefined };
  };
  const conflict =
    add.error instanceof ApiError &&
    add.error.status === 409 &&
    add.error.code !== 'error.periodClosed';
  return (
    <form onSubmit={form.onSubmit((values) => add.mutate(values))} noValidate>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('attendance.adjust.formHint')} ({props.month})
        </Text>
        {conflict ? (
          <Alert color="red" icon={<IconAlertCircle size={18} aria-hidden />} role="alert">
            {t('attendance.adjust.conflict')}
          </Alert>
        ) : (
          <MutationError error={add.error} />
        )}
        <TextInput
          type="date"
          label={t('attendance.adjust.date')}
          withAsterisk
          key={form.key('workDate')}
          {...field('workDate')}
        />
        <NumberInput
          label={t('attendance.adjust.minutes')}
          description={t('attendance.adjust.minutesHint')}
          allowDecimal={false}
          allowNegative
          withAsterisk
          key={form.key('minutes')}
          {...field('minutes')}
        />
        <Textarea
          label={t('attendance.adjust.reason')}
          description={t('attendance.adjust.reasonHint')}
          maxLength={300}
          rows={3}
          withAsterisk
          key={form.key('reason')}
          {...field('reason')}
        />
        <TextInput
          label={t('attendance.adjust.reference')}
          description={t('attendance.adjust.referenceHint')}
          maxLength={64}
          key={form.key('reference')}
          {...field('reference')}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={add.isPending}>
            {t('attendance.adjust.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

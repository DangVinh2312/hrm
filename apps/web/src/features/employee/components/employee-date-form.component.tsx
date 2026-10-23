import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { MutationError } from '../../account/components/mutation-error.component';
import { isMessageKey, type MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { businessToday } from '../../../i18n/format.helper';
import { businessDateSchema } from '../employee-form.schema';

const dateSchema = z.object({ date: businessDateSchema });

/** One business date, e.g. the first official day or the last working day. */
export function DateModal(props: {
  readonly label: MessageKey;
  readonly description: MessageKey;
  readonly submit: MessageKey;
  /** Start from today (Asia/Ho_Chi_Minh) and warn, without blocking, while the date is later. */
  readonly today?: { readonly futureWarning: MessageKey };
  readonly action: (date: string) => Promise<unknown>;
  readonly onDone: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const initial = props.today ? businessToday() : '';
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: { date: initial },
    validate: schemaResolver(dateSchema, { sync: true }),
  });
  const [date, setDate] = useState(initial);
  form.watch('date', ({ value }) => setDate(value));
  const future =
    props.today !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date) && date > businessToday();
  const run = useMutation({
    mutationFn: (date: string) => props.action(date),
    onSuccess: () => props.onDone(),
  });
  const error = form.errors.date;
  return (
    <form onSubmit={form.onSubmit((values) => run.mutate(values.date))} noValidate>
      <Stack gap="md">
        <MutationError error={run.error} />
        <TextInput
          type="date"
          label={t(props.label)}
          description={t(props.description)}
          withAsterisk
          key={form.key('date')}
          {...form.getInputProps('date')}
          error={isMessageKey(error) ? t(error) : undefined}
        />
        {future && props.today && (
          <Text size="sm" c="orange.8" role="status">
            {t(props.today.futureWarning)}
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={run.isPending}>
            {t(props.submit)}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

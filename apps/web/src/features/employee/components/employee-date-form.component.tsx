import { Button, Group, Stack, TextInput } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { MutationError } from '../../hr/components/mutation-error.component';
import { isMessageKey, type MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { businessDateSchema } from '../employee-form.schema';

const dateSchema = z.object({ date: businessDateSchema });

/** One business date, e.g. the first official day or the last working day. */
export function DateModal(props: {
  readonly label: MessageKey;
  readonly description: MessageKey;
  readonly submit: MessageKey;
  readonly action: (date: string) => Promise<unknown>;
  readonly onDone: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: { date: '' },
    validate: schemaResolver(dateSchema, { sync: true }),
  });
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

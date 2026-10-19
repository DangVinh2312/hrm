import {
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { IconBeach, IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '../../auth/session.provider';
import { MutationError } from '../../hr/components/mutation-error.component';
import { QueryState } from '../../hr/components/query-state.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { formatDate, formatDays } from '../../i18n/format.helper';
import { isMessageKey } from '../../i18n/i18n.helper';
import { useI18n } from '../../i18n/i18n.provider';
import { businessDateSchema, leaveDaysSchema } from '../employee-form.schema';
import { useEmployeeRefresh } from './employee-profile.component';

const rateSchema = z.object({ effectiveFrom: businessDateSchema, days: leaveDaysSchema });
type RateValues = z.input<typeof rateSchema>;

function RateForm(props: { readonly employeeId: string; readonly onClose: () => void }) {
  const { t } = useI18n();
  const { employees } = useHrServices();
  const refresh = useEmployeeRefresh();
  const form = useForm<RateValues>({
    mode: 'uncontrolled',
    initialValues: { effectiveFrom: '', days: 12 },
    validate: schemaResolver(rateSchema, { sync: true }),
  });
  const add = useMutation({
    mutationFn: (values: RateValues) => {
      const parsed = rateSchema.parse(values);
      return employees.addLeaveRate(props.employeeId, {
        effectiveFrom: parsed.effectiveFrom,
        annualMinutes: parsed.days * 480,
      });
    },
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
  });
  const field = (name: keyof RateValues) => {
    const input = form.getInputProps(name);
    const error: unknown = input.error;
    return { ...input, error: isMessageKey(error) ? t(error) : undefined };
  };
  return (
    <form onSubmit={form.onSubmit((values) => add.mutate(values))} noValidate>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('employee.leaveRate.addHint')}
        </Text>
        <MutationError error={add.error} />
        <TextInput
          type="date"
          label={t('employee.leaveRate.effectiveFrom')}
          withAsterisk
          key={form.key('effectiveFrom')}
          {...field('effectiveFrom')}
        />
        <NumberInput
          label={t('employee.field.annualLeaveDays')}
          description={t('employee.field.annualLeaveHint')}
          min={12}
          max={366}
          step={0.25}
          decimalScale={2}
          withAsterisk
          key={form.key('days')}
          {...field('days')}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={add.isPending}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/**
 * F3 (design §5.1): annual leave rates by effective date. Rows are only ever added, so history
 * stays exact; the API returns nothing outside the caller's scope and the section then hides.
 */
export function EmployeeLeaveRateSection(props: {
  readonly employeeId: string;
  readonly canManage: boolean;
}) {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { employees } = useHrServices();
  const [adding, add] = useDisclosure();
  const rates = useQuery({
    queryKey: [namespace, 'employees', 'leaveRates', props.employeeId],
    queryFn: ({ signal }) => employees.leaveRates(props.employeeId, signal),
  });
  if (!props.canManage && rates.data?.length === 0) return null;
  return (
    <Card padding="lg">
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs">
            <IconBeach size={20} stroke={1.75} aria-hidden />
            <Title order={2}>{t('employee.leaveRate.title')}</Title>
          </Group>
          {props.canManage && (
            <Button
              variant="light"
              leftSection={<IconPlus size={18} stroke={1.75} aria-hidden />}
              onClick={add.open}
            >
              {t('employee.leaveRate.add')}
            </Button>
          )}
        </Group>
        <QueryState pending={rates.isPending} error={rates.error} onRetry={() => rates.refetch()}>
          <Table.ScrollContainer minWidth={360}>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('employee.leaveRate.effectiveFrom')}</Table.Th>
                  <Table.Th>{t('employee.leaveRate.daysPerYear')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rates.data?.map((rate) => (
                  <Table.Tr key={rate.id}>
                    <Table.Td>{formatDate(rate.effectiveFrom)}</Table.Td>
                    <Table.Td>{formatDays(rate.annualMinutes, locale)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </QueryState>
      </Stack>
      <Modal opened={adding} onClose={add.close} title={t('employee.leaveRate.add')}>
        <RateForm employeeId={props.employeeId} onClose={add.close} />
      </Modal>
    </Card>
  );
}

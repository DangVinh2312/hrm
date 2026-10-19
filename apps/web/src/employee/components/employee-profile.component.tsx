import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { IconCalendarCheck, IconDoorExit, IconPencil } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { useSession } from '../../auth/session.provider';
import { MutationError } from '../../hr/components/mutation-error.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { formatDate } from '../../i18n/format.helper';
import { isMessageKey, type MessageKey } from '../../i18n/i18n.helper';
import { useI18n } from '../../i18n/i18n.provider';
import type { Employee } from '../employee.client';
import { businessDateSchema, profileSchema } from '../employee-form.schema';

const editSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,32}$/, 'employee.form.codeInvalid'),
    fullName: z.string().trim().min(1, 'employee.form.required').max(200, 'employee.form.tooLong'),
  })
  .and(profileSchema);
const dateSchema = z.object({ date: businessDateSchema });

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Stack gap={2}>
      <Text size="sm" c="dimmed">
        {props.label}
      </Text>
      <Text component="div">{props.children}</Text>
    </Stack>
  );
}

/** Invalidates the cached employee reads of this session after a successful change. */
export function useEmployeeRefresh() {
  const { namespace } = useSession();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [namespace, 'employees'] });
}

function EditModal(props: { readonly employee: Employee; readonly onClose: () => void }) {
  const { t } = useI18n();
  const { employees } = useHrServices();
  const refresh = useEmployeeRefresh();
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: {
      code: props.employee.code,
      fullName: props.employee.fullName,
      position: props.employee.position ?? '',
      // null, not '': Select shows its clear button for any non-null value.
      classification: props.employee.classification,
    },
    validate: schemaResolver(editSchema, { sync: true }),
  });
  const save = useMutation({
    mutationFn: (values: z.input<typeof editSchema>) =>
      employees.update(props.employee.id, {
        expectedVersion: props.employee.version,
        ...editSchema.parse(values),
      }),
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
  });
  const message = (key: unknown) => (isMessageKey(key) ? t(key) : undefined);
  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))} noValidate>
      <Stack gap="md">
        <MutationError error={save.error} />
        <TextInput
          label={t('employee.field.code')}
          withAsterisk
          key={form.key('code')}
          {...form.getInputProps('code')}
          error={message(form.errors.code)}
        />
        <TextInput
          label={t('employee.field.fullName')}
          withAsterisk
          key={form.key('fullName')}
          {...form.getInputProps('fullName')}
          error={message(form.errors.fullName)}
        />
        <TextInput
          label={t('employee.field.position')}
          maxLength={100}
          key={form.key('position')}
          {...form.getInputProps('position')}
          error={message(form.errors.position)}
        />
        <Select
          label={t('employee.field.classification')}
          data={(['fullTime', 'contractor'] as const).map((value) => ({
            value,
            label: t(`employee.classification.${value}`),
          }))}
          clearable
          key={form.key('classification')}
          {...form.getInputProps('classification')}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/** One business date, e.g. the first official day or the last working day. */
function DateModal(props: {
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

/** F1 (design §5.1): code, name, dates, status history and current teams. */
export function EmployeeProfile(props: {
  readonly employee: Employee;
  readonly canManage: boolean;
}) {
  const { t } = useI18n();
  const { employees } = useHrServices();
  const { employee } = props;
  const refresh = useEmployeeRefresh();
  const [editing, edit] = useDisclosure();
  const [confirming, confirm] = useDisclosure();
  const [terminating, terminate] = useDisclosure();
  const open = employee.periods.at(-1);
  const canConfirm = props.canManage && open?.endsOn === null && open.status === 'probation';
  const canTerminate = props.canManage && employee.terminatedOn === null;

  return (
    <Card padding="lg">
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Title order={2}>{t('employee.profile.title')}</Title>
          {props.canManage && (
            <Group gap="xs">
              <Button
                variant="light"
                leftSection={<IconPencil size={18} stroke={1.75} aria-hidden />}
                onClick={edit.open}
              >
                {t('common.edit')}
              </Button>
              {canConfirm && (
                <Button
                  variant="light"
                  color="green"
                  leftSection={<IconCalendarCheck size={18} stroke={1.75} aria-hidden />}
                  onClick={confirm.open}
                >
                  {t('employee.status.confirmOfficial')}
                </Button>
              )}
              {canTerminate && (
                <Button
                  variant="subtle"
                  color="red"
                  leftSection={<IconDoorExit size={18} stroke={1.75} aria-hidden />}
                  onClick={terminate.open}
                >
                  {t('employee.status.terminate')}
                </Button>
              )}
            </Group>
          )}
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
          <Field label={t('employee.field.code')}>{employee.code}</Field>
          <Field label={t('employee.field.fullName')}>{employee.fullName}</Field>
          <Field label={t('employee.field.hiredOn')}>{formatDate(employee.hiredOn)}</Field>
          <Field label={t('employee.field.terminatedOn')}>
            {formatDate(employee.terminatedOn)}
          </Field>
          <Field label={t('employee.field.position')}>{employee.position ?? '—'}</Field>
          <Field label={t('employee.field.classification')}>
            {employee.classification
              ? t(`employee.classification.${employee.classification}`)
              : '—'}
          </Field>
        </SimpleGrid>
        <Stack gap="xs">
          <Text fw={600}>{t('employee.field.teams')}</Text>
          {employee.teams.length === 0 ? (
            <Text c="dimmed" size="sm">
              {t('employee.profile.noTeam')}
            </Text>
          ) : (
            <Group gap="xs">
              {employee.teams.map((team) => (
                <Badge key={team.id} variant={team.primary ? 'filled' : 'light'} size="lg">
                  {team.primary ? `${team.name} · ${t('team.member.primary')}` : team.name}
                </Badge>
              ))}
            </Group>
          )}
        </Stack>
        <Stack gap="xs">
          <Text fw={600}>{t('employee.profile.statusHistory')}</Text>
          <Table.ScrollContainer minWidth={420}>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('employee.field.status')}</Table.Th>
                  <Table.Th>{t('employee.profile.from')}</Table.Th>
                  <Table.Th>{t('employee.profile.until')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {employee.periods.map((period) => (
                  <Table.Tr key={period.startsOn}>
                    <Table.Td>{t(`employee.state.${period.status}`)}</Table.Td>
                    <Table.Td>{formatDate(period.startsOn)}</Table.Td>
                    <Table.Td>
                      {period.endsOn === null
                        ? t('employee.profile.ongoing')
                        : formatDate(period.endsOn)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Text size="xs" c="dimmed">
            {t('employee.profile.untilHint')}
          </Text>
        </Stack>
      </Stack>
      <Modal opened={editing} onClose={edit.close} title={t('employee.edit.title')}>
        <EditModal employee={employee} onClose={edit.close} />
      </Modal>
      <Modal
        opened={confirming}
        onClose={confirm.close}
        title={t('employee.status.confirmOfficial')}
      >
        <DateModal
          label="employee.status.effectiveOn"
          description="employee.status.effectiveOnHint"
          submit="employee.status.confirmOfficial"
          action={(date) => employees.confirmOfficial(employee.id, date)}
          onDone={async () => {
            await refresh();
            confirm.close();
          }}
          onClose={confirm.close}
        />
      </Modal>
      <Modal opened={terminating} onClose={terminate.close} title={t('employee.status.terminate')}>
        <DateModal
          label="employee.status.terminatedOn"
          description="employee.status.terminatedOnHint"
          submit="employee.status.terminate"
          action={(date) => employees.terminate(employee.id, date)}
          onDone={async () => {
            await refresh();
            terminate.close();
          }}
          onClose={terminate.close}
        />
      </Modal>
    </Card>
  );
}

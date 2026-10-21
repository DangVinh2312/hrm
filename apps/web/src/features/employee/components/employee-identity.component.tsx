import {
  Button,
  Card,
  Group,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { IconPencil, IconShieldLock } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '../../auth/session.provider';
import { MutationError } from '../../hr/components/mutation-error.component';
import { QueryState } from '../../hr/components/query-state.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { formatDate } from '../../../i18n/format.helper';
import { isMessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { ApiError } from '../../../infrastructure/http.client';
import type { EmployeeIdentity } from '../employee.client';
import { identitySchema } from '../employee-form.schema';
import { useEmployeeRefresh } from './employee-profile.component';

type IdentityValues = z.input<typeof identitySchema>;

function IdentityForm(props: {
  readonly identity: EmployeeIdentity;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { employees } = useHrServices();
  const refresh = useEmployeeRefresh();
  const form = useForm<IdentityValues>({
    mode: 'uncontrolled',
    initialValues: {
      dateOfBirth: props.identity.dateOfBirth ?? '',
      documentKind: props.identity.documentKind ?? '',
      documentNumber: props.identity.documentNumber ?? '',
      taxCode: props.identity.taxCode ?? '',
      gender: props.identity.gender,
      phone: props.identity.phone ?? '',
      workEmail: props.identity.workEmail ?? '',
    },
    validate: schemaResolver(identitySchema, { sync: true }),
  });
  const save = useMutation({
    mutationFn: (values: IdentityValues) =>
      employees.updateIdentity(props.identity.employeeId, {
        expectedVersion: props.identity.version,
        identity: identitySchema.parse(values),
      }),
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
  });
  const field = (name: keyof IdentityValues) => {
    const input = form.getInputProps(name);
    const error: unknown = input.error;
    return { ...input, error: isMessageKey(error) ? t(error) : undefined };
  };
  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))} noValidate>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('employee.identity.freshHint')}
        </Text>
        <MutationError error={save.error} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            type="date"
            label={t('employee.field.dateOfBirth')}
            key={form.key('dateOfBirth')}
            {...field('dateOfBirth')}
          />
          <Select
            label={t('employee.field.documentKind')}
            data={(['cccd', 'cmnd', 'passport'] as const).map((kind) => ({
              value: kind,
              label: t(`employee.documentKind.${kind}`),
            }))}
            clearable
            key={form.key('documentKind')}
            {...field('documentKind')}
          />
          <TextInput
            label={t('employee.field.documentNumber')}
            key={form.key('documentNumber')}
            {...field('documentNumber')}
          />
          <TextInput
            label={t('employee.field.taxCode')}
            key={form.key('taxCode')}
            {...field('taxCode')}
          />
          <Select
            label={t('employee.field.gender')}
            data={(['male', 'female', 'other'] as const).map((value) => ({
              value,
              label: t(`employee.gender.${value}`),
            }))}
            clearable
            key={form.key('gender')}
            {...field('gender')}
          />
          <TextInput
            type="tel"
            label={t('employee.field.phone')}
            maxLength={32}
            key={form.key('phone')}
            {...field('phone')}
          />
          <TextInput
            type="email"
            label={t('employee.field.workEmail')}
            maxLength={254}
            key={form.key('workEmail')}
            {...field('workEmail')}
          />
        </SimpleGrid>
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

/**
 * F2 (design §5.1, D08): shown only to the employee and HR. Lead/COO get 404 from the API, and
 * then the section is not rendered at all, so nothing hints at what exists.
 */
export function EmployeeIdentitySection(props: {
  readonly employeeId: string;
  readonly canManage: boolean;
}) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const { employees } = useHrServices();
  const [editing, edit] = useDisclosure();
  const identity = useQuery({
    queryKey: [namespace, 'employees', 'identity', props.employeeId],
    queryFn: ({ signal }) => employees.identity(props.employeeId, signal),
  });
  if (identity.error instanceof ApiError && identity.error.status === 404) return null;
  const data = identity.data;
  const document = data?.documentKind
    ? `${t(`employee.documentKind.${data.documentKind}`)} · ${data.documentNumber ?? ''}`
    : '—';
  return (
    <Card padding="lg">
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs">
            <IconShieldLock size={20} stroke={1.75} aria-hidden />
            <Title order={2}>{t('employee.identity.title')}</Title>
          </Group>
          {props.canManage && data && (
            <Button
              variant="light"
              leftSection={<IconPencil size={18} stroke={1.75} aria-hidden />}
              onClick={edit.open}
            >
              {t('common.edit')}
            </Button>
          )}
        </Group>
        <QueryState
          pending={identity.isPending}
          error={identity.error}
          onRetry={() => identity.refetch()}
        >
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Stack gap={2}>
              <Text size="sm" c="dimmed">
                {t('employee.field.dateOfBirth')}
              </Text>
              <Text>{formatDate(data?.dateOfBirth)}</Text>
            </Stack>
            <Stack gap={2}>
              <Text size="sm" c="dimmed">
                {t('employee.field.document')}
              </Text>
              <Text>{document}</Text>
            </Stack>
            <Stack gap={2}>
              <Text size="sm" c="dimmed">
                {t('employee.field.taxCode')}
              </Text>
              <Text>{data?.taxCode ?? '—'}</Text>
            </Stack>
            <Stack gap={2}>
              <Text size="sm" c="dimmed">
                {t('employee.field.gender')}
              </Text>
              <Text>{data?.gender ? t(`employee.gender.${data.gender}`) : '—'}</Text>
            </Stack>
            <Stack gap={2}>
              <Text size="sm" c="dimmed">
                {t('employee.field.phone')}
              </Text>
              <Text>{data?.phone ?? '—'}</Text>
            </Stack>
            <Stack gap={2}>
              <Text size="sm" c="dimmed">
                {t('employee.field.workEmail')}
              </Text>
              <Text>{data?.workEmail ?? '—'}</Text>
            </Stack>
          </SimpleGrid>
        </QueryState>
      </Stack>
      {data && (
        <Modal opened={editing} onClose={edit.close} title={t('employee.identity.edit')} size="lg">
          <IdentityForm identity={data} onClose={edit.close} />
        </Modal>
      )}
    </Card>
  );
}

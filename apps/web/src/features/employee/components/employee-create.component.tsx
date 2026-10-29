import {
  Badge,
  Button,
  Group,
  Input,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useId, useState } from 'react';
import { schemaResolver, useForm } from '@mantine/form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { useSession } from '../../auth/session.provider';
import { BusinessDateInput } from '../../../components/business-date-input.component';
import { MutationError } from '../../account/components/mutation-error.component';
import { useEmployeeClient } from '../employee-services.provider';
import { isMessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { identitySchema, leaveDaysSchema, profileSchema } from '../employee-form.schema';
import { Section } from './employee-form-section.component';

const createSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,32}$/, 'employee.form.codeInvalid'),
    fullName: z.string().trim().min(1, 'employee.form.required').max(200, 'employee.form.tooLong'),
    hiredOn: z.iso.date('employee.form.dateInvalid'),
    status: z.enum(['probation', 'official']),
    annualLeaveDays: leaveDaysSchema,
  })
  .and(identitySchema)
  .and(profileSchema);

type CreateValues = z.input<typeof createSchema>;

const initialValues: CreateValues = {
  code: '',
  fullName: '',
  hiredOn: '',
  status: 'probation',
  annualLeaveDays: 12,
  dateOfBirth: '',
  // null, not '': Select shows its clear button for any non-null value.
  documentKind: null,
  documentNumber: '',
  taxCode: '',
  gender: null,
  phone: '',
  workEmail: '',
  position: '',
  classification: null,
};

/** HR creates a profile with F1, optional F2 and the F3 rate (one API call, one commit). */
export function EmployeeCreateModal(props: {
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const employees = useEmployeeClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const statusId = useId();
  // The leave rate belongs to the official status only: the field exists while chosen.
  const [official, setOfficial] = useState(false);
  const form = useForm<CreateValues>({
    mode: 'uncontrolled',
    initialValues,
    validate: schemaResolver(createSchema, { sync: true }),
  });
  const create = useMutation({
    mutationFn: (values: CreateValues) => {
      const parsed = createSchema.parse(values);
      return employees.create({
        code: parsed.code,
        fullName: parsed.fullName,
        hiredOn: parsed.hiredOn,
        status: parsed.status,
        ...(parsed.status === 'official'
          ? { annualLeaveMinutes: parsed.annualLeaveDays * 480 }
          : {}),
        identity: {
          dateOfBirth: parsed.dateOfBirth,
          documentKind: parsed.documentKind,
          documentNumber: parsed.documentNumber,
          taxCode: parsed.taxCode,
          gender: parsed.gender,
          phone: parsed.phone,
          workEmail: parsed.workEmail,
        },
        position: parsed.position,
        classification: parsed.classification,
      });
    },
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: [namespace, 'employees'] });
      form.reset();
      setOfficial(false);
      props.onClose();
      await navigate(`/employees/${id}`);
    },
  });
  const error = (key: string | undefined) =>
    key !== undefined && isMessageKey(key) ? t(key) : undefined;
  const field = (name: keyof CreateValues) => {
    const input = form.getInputProps(name);
    return { ...input, error: error(input.error as string | undefined) };
  };

  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title={
        <Text span size="lg" fw={700}>
          {t('employee.create.title')}
        </Text>
      }
      size="lg"
    >
      <form onSubmit={form.onSubmit((values) => create.mutate(values))} noValidate>
        <Stack gap="xl">
          <MutationError error={create.error} />
          <Section title={t('employee.section.basic')}>
            <TextInput
              label={t('employee.field.code')}
              description={t('employee.field.codeHint')}
              withAsterisk
              maxLength={32}
              key={form.key('code')}
              {...field('code')}
            />
            <TextInput
              label={t('employee.field.fullName')}
              withAsterisk
              maxLength={200}
              key={form.key('fullName')}
              {...field('fullName')}
            />
          </Section>
          <Section title={t('employee.section.work')}>
            <BusinessDateInput
              label={t('employee.field.hiredOn')}
              withAsterisk
              key={form.key('hiredOn')}
              {...field('hiredOn')}
            />
            {/* A radio group has no single input to point a <label> at; name it by id instead. */}
            <Input.Wrapper
              id={statusId}
              labelElement="div"
              label={t('employee.field.status')}
              withAsterisk
            >
              <SegmentedControl
                aria-labelledby={`${statusId}-label`}
                fullWidth
                data={[
                  { value: 'probation', label: t('employee.state.probation') },
                  { value: 'official', label: t('employee.state.official') },
                ]}
                key={form.key('status')}
                {...form.getInputProps('status')}
                onChange={(value) => {
                  setOfficial(value === 'official');
                  form.setFieldValue('status', value === 'official' ? 'official' : 'probation');
                  // The hidden field must stay valid: back to the default, never a stale value.
                  if (value !== 'official') form.setFieldValue('annualLeaveDays', 12);
                }}
              />
            </Input.Wrapper>
            {official && (
              <NumberInput
                label={t('employee.field.annualLeaveDays')}
                description={t('employee.field.annualLeaveHint')}
                min={12}
                max={366}
                step={0.25}
                decimalScale={2}
                withAsterisk
                key={form.key('annualLeaveDays')}
                {...field('annualLeaveDays')}
              />
            )}
            <TextInput
              label={t('employee.field.position')}
              maxLength={100}
              key={form.key('position')}
              {...field('position')}
            />
            <Select
              label={t('employee.field.classification')}
              data={(['fullTime', 'contractor'] as const).map((value) => ({
                value,
                label: t(`employee.classification.${value}`),
              }))}
              clearable
              key={form.key('classification')}
              {...field('classification')}
            />
          </Section>
          <Section
            title={t('employee.section.identity')}
            aside={
              <Badge variant="light" color="gray" size="sm">
                {t('common.optional')}
              </Badge>
            }
            hint={t('employee.identity.optionalHint')}
          >
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
              maxLength={20}
              key={form.key('documentNumber')}
              {...field('documentNumber')}
            />
            <BusinessDateInput
              label={t('employee.field.dateOfBirth')}
              key={form.key('dateOfBirth')}
              {...field('dateOfBirth')}
            />
            <TextInput
              label={t('employee.field.taxCode')}
              maxLength={17}
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
          </Section>
          <Group justify="flex-end">
            <Button variant="default" onClick={props.onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('employee.create.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

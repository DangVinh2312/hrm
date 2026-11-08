import { ActionIcon, Button, Card, Group, Modal, Stack, Table, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconClockEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BusinessDateInput } from '../../../components/business-date-input.component';
import { QueryState } from '../../../components/query-state.component';
import { WeekFramesInput } from '../../../components/week-frames-input.component';
import {
  type Frame,
  type WeekDraft,
  emptyWeek,
  frameLabel,
  isoWeekdayName,
  weekIssue,
  weekOf,
} from '../../../components/week-frames.helper';
import { formatDate } from '../../../i18n/format.helper';
import type { MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { ApiError } from '../../../infrastructure/http.client';
import { MutationError } from '../../account/components/mutation-error.component';
import { useSession } from '../../auth/session.provider';
import { useEmployeeClient } from '../employee-services.provider';

/**
 * The month of `date` (`YYYY-MM-DD`), or the month after `today`, from no earlier than the day
 * after `today` (a frame starts after today); a month already over gives tomorrow's month.
 */
export function wholeMonth(date: string, today: string): { from: string; to: string } {
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000);
  const month = (year: number, index: number) => ({
    start: new Date(Date.UTC(year, index, 1)),
    end: new Date(Date.UTC(year, index + 1, 0)),
  });
  const [year = 0, index = 1] = (date || today).split('-').map(Number);
  let chosen = month(year, date ? index - 1 : index);
  if (chosen.end < tomorrow) chosen = month(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth());
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  return { from: iso(chosen.start < tomorrow ? tomorrow : chosen.start), to: iso(chosen.end) };
}

function FrameForm(props: {
  readonly employeeId: string;
  readonly today: string;
  readonly maxMinutes: number;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const employees = useEmployeeClient();
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [draft, setDraft] = useState<WeekDraft>(emptyWeek);
  const [hint, setHint] = useState<MessageKey>();
  const add = useMutation({
    mutationFn: (days: readonly Frame[]) =>
      employees.addScheduleFrame(props.employeeId, {
        validFrom,
        validTo: validTo || null,
        days,
      }),
    onSuccess: async () => {
      await props.onSaved();
      props.onClose();
    },
  });
  const submit = () => {
    const week = weekOf(draft);
    const issue =
      validFrom <= props.today
        ? 'schedule.form.future'
        : validTo && validTo < validFrom
          ? 'schedule.form.rangeOrder'
          : weekIssue(week, props.maxMinutes);
    setHint(issue);
    if (!issue && week) add.mutate(week);
  };
  const fillMonth = () => {
    const month = wholeMonth(validFrom, props.today);
    setValidFrom(month.from);
    setValidTo(month.to);
  };
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t('schedule.employee.addHint')}
      </Text>
      <MutationError error={add.error} />
      <Group align="flex-end" wrap="wrap">
        <BusinessDateInput
          label={t('schedule.employee.validFrom')}
          withAsterisk
          value={validFrom}
          onChange={setValidFrom}
        />
        <BusinessDateInput
          label={t('schedule.employee.validTo')}
          description={t('schedule.employee.validToHint')}
          value={validTo}
          onChange={setValidTo}
        />
        <Button variant="default" onClick={fillMonth}>
          {t('schedule.employee.wholeMonth')}
        </Button>
      </Group>
      <WeekFramesInput
        value={draft}
        onChange={setDraft}
        maxMinutes={props.maxMinutes}
        emptyLabel={t('schedule.employee.companyHours')}
      />
      {hint && (
        <Text size="sm" c="red" role="alert">
          {t(hint)}
        </Text>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={props.onClose}>
          {t('common.cancel')}
        </Button>
        <Button loading={add.isPending} onClick={submit}>
          {t('common.save')}
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * ADR-19: the employee's own hours by date range; an empty weekday keeps the company's. Hidden
 * when the API answers 404 (not the caller's to read). A frame not started yet is removed, the one
 * in force ends today.
 */
export function EmployeeScheduleSection(props: {
  readonly employeeId: string;
  readonly canManage: boolean;
}) {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const employees = useEmployeeClient();
  const queryClient = useQueryClient();
  const [adding, add] = useDisclosure();
  const queryKey = [namespace, 'employees', 'scheduleFrames', props.employeeId];
  const frames = useQuery({
    queryKey,
    queryFn: ({ signal }) => employees.scheduleFrames(props.employeeId, signal),
  });
  // The frames change the hours each day gets, which request forms read.
  const refresh = () =>
    queryClient
      .invalidateQueries({ queryKey: [namespace, 'employees', 'schedule'] })
      .then(() => queryClient.invalidateQueries({ queryKey }));
  const end = useMutation({
    mutationFn: (frameId: string) => employees.endScheduleFrame(props.employeeId, frameId),
    onSuccess: refresh,
  });
  if (frames.error instanceof ApiError && frames.error.status === 404) return null;
  const data = frames.data;
  if (!props.canManage && data?.frames.length === 0) return null;

  return (
    <Card padding="lg">
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs">
            <IconClockEdit size={20} stroke={1.75} aria-hidden />
            <Title order={2}>{t('schedule.employee.title')}</Title>
          </Group>
          {props.canManage && data && (
            <Button
              variant="light"
              leftSection={<IconPlus size={18} stroke={1.75} aria-hidden />}
              onClick={add.open}
            >
              {t('schedule.employee.add')}
            </Button>
          )}
        </Group>
        <MutationError error={end.error} />
        <QueryState
          pending={frames.isPending}
          error={frames.error}
          onRetry={() => frames.refetch()}
        >
          {data?.frames.length === 0 && <Text c="dimmed">{t('schedule.employee.empty')}</Text>}
          {data?.frames.map((frame) => {
            const range = `${formatDate(frame.validFrom)} – ${
              frame.validTo ? formatDate(frame.validTo) : t('schedule.employee.open')
            }`;
            const started = frame.validFrom <= data.today;
            return (
              <Stack key={frame.id} gap="xs">
                <Group justify="space-between">
                  <Text fw={600}>{range}</Text>
                  {props.canManage && (frame.validTo === null || frame.validTo > data.today) && (
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="lg"
                      aria-label={`${t(started ? 'schedule.employee.end' : 'schedule.employee.remove')} ${range}`}
                      loading={end.isPending && end.variables === frame.id}
                      disabled={end.isPending}
                      onClick={() => end.mutate(frame.id)}
                    >
                      <IconTrash size={18} stroke={1.75} aria-hidden />
                    </ActionIcon>
                  )}
                </Group>
                <Table verticalSpacing={4} aria-label={range}>
                  <Table.Tbody>
                    {frame.days.map((day, index) =>
                      day.length === 0 ? null : (
                        <Table.Tr key={index}>
                          <Table.Th w={160}>{isoWeekdayName(index + 1, locale)}</Table.Th>
                          <Table.Td>{frameLabel(day)}</Table.Td>
                        </Table.Tr>
                      ),
                    )}
                  </Table.Tbody>
                </Table>
              </Stack>
            );
          })}
        </QueryState>
      </Stack>
      {data && (
        <Modal opened={adding} onClose={add.close} title={t('schedule.employee.add')} size="xl">
          <FrameForm
            employeeId={props.employeeId}
            today={data.today}
            maxMinutes={data.maxMinutes}
            onClose={add.close}
            onSaved={refresh}
          />
        </Modal>
      )}
    </Card>
  );
}

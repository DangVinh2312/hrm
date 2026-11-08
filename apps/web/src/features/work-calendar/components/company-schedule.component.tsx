import { ActionIcon, Button, Card, Group, Modal, Stack, Table, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconClockHour4, IconPencil, IconTrash } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { BusinessDateInput } from '../../../components/business-date-input.component';
import { QueryState } from '../../../components/query-state.component';
import { WeekFramesInput } from '../../../components/week-frames-input.component';
import {
  type Frame,
  type WeekDraft,
  draftOf,
  frameLabel,
  isoWeekdayName,
  weekIssue,
  weekOf,
} from '../../../components/week-frames.helper';
import { formatDate } from '../../../i18n/format.helper';
import type { MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { MutationError } from '../../account/components/mutation-error.component';
import { useWorkCalendarClient } from '../work-calendar-services.provider';
import type { CompanySchedule } from '../work-calendar.client';
import { useCalendarRefresh, useCompanySchedule } from '../work-calendar.helper';

function ScheduleForm(props: { readonly schedule: CompanySchedule; readonly onClose: () => void }) {
  const { t } = useI18n();
  const workCalendar = useWorkCalendarClient();
  const refresh = useCalendarRefresh();
  const last = props.schedule.versions.at(-1);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [draft, setDraft] = useState<WeekDraft>(draftOf(last?.days ?? []));
  const [hint, setHint] = useState<MessageKey>();
  const save = useMutation({
    mutationFn: (days: readonly Frame[]) => workCalendar.putSchedule(effectiveFrom, days),
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
  });
  const submit = () => {
    const week = weekOf(draft);
    const issue =
      effectiveFrom > props.schedule.today
        ? weekIssue(week, props.schedule.maxMinutes)
        : 'schedule.form.future';
    setHint(issue);
    if (!issue && week) save.mutate(week);
  };
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t('schedule.company.editHint')}
      </Text>
      <MutationError error={save.error} />
      <BusinessDateInput
        label={t('schedule.effectiveFrom')}
        withAsterisk
        value={effectiveFrom}
        onChange={setEffectiveFrom}
      />
      <WeekFramesInput
        value={draft}
        onChange={setDraft}
        maxMinutes={props.schedule.maxMinutes}
        emptyLabel={t('schedule.dayOff')}
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
        <Button loading={save.isPending} onClick={submit}>
          {t('common.save')}
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * ADR-19: the company week in force today and every later version. A later version can be
 * replaced or removed; the one in force never changes (the API refuses it).
 */
export function CompanyScheduleSection(props: { readonly canManage: boolean }) {
  const { t, locale } = useI18n();
  const workCalendar = useWorkCalendarClient();
  const refresh = useCalendarRefresh();
  const [editing, edit] = useDisclosure();
  const titleId = useId();
  const schedule = useCompanySchedule();
  const remove = useMutation({
    mutationFn: (effectiveFrom: string) => workCalendar.deleteSchedule(effectiveFrom),
    onSuccess: refresh,
  });
  const data = schedule.data;

  return (
    <Card padding="lg" component="section" aria-labelledby={titleId}>
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs">
            <IconClockHour4 size={20} stroke={1.75} aria-hidden />
            <Title order={2} id={titleId}>
              {t('schedule.company.title')}
            </Title>
          </Group>
          {props.canManage && data && (
            <Button
              variant="light"
              leftSection={<IconPencil size={18} stroke={1.75} aria-hidden />}
              onClick={edit.open}
            >
              {t('schedule.company.edit')}
            </Button>
          )}
        </Group>
        <MutationError error={remove.error} />
        <QueryState
          pending={schedule.isPending}
          error={schedule.error}
          onRetry={() => schedule.refetch()}
        >
          {data?.versions.map((version) => {
            const current = version.effectiveFrom <= data.today;
            const heading = current
              ? t('schedule.company.current')
              : `${t('schedule.effectiveFrom')} ${formatDate(version.effectiveFrom)}`;
            return (
              <Stack key={version.effectiveFrom} gap="xs">
                <Group justify="space-between">
                  <Text fw={600}>{heading}</Text>
                  {props.canManage && !current && (
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="lg"
                      aria-label={`${t('schedule.company.remove')} ${formatDate(version.effectiveFrom)}`}
                      loading={remove.isPending && remove.variables === version.effectiveFrom}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(version.effectiveFrom)}
                    >
                      <IconTrash size={18} stroke={1.75} aria-hidden />
                    </ActionIcon>
                  )}
                </Group>
                <Table verticalSpacing={4} aria-label={heading}>
                  <Table.Tbody>
                    {version.days.map((frame, index) => (
                      <Table.Tr key={index}>
                        <Table.Th w={160}>{isoWeekdayName(index + 1, locale)}</Table.Th>
                        <Table.Td>
                          {frame.length > 0 ? frameLabel(frame) : t('schedule.dayOff')}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Stack>
            );
          })}
        </QueryState>
      </Stack>
      {data && (
        <Modal opened={editing} onClose={edit.close} title={t('schedule.company.edit')} size="xl">
          <ScheduleForm schedule={data} onClose={edit.close} />
        </Modal>
      )}
    </Card>
  );
}

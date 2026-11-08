import { ActionIcon, Button, Group, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useI18n } from '../i18n/i18n.provider';
import {
  MAX_SHIFTS,
  type ShiftDraft,
  type WeekDraft,
  frameIssue,
  isoWeekdayName,
  timeMinute,
} from './week-frames.helper';

/**
 * Seven weekdays, each with up to three `[start, end)` shifts typed as times. An empty weekday is
 * `emptyLabel` (a day off, or the company's hours for an employee frame).
 */
export function WeekFramesInput(props: {
  readonly value: WeekDraft;
  readonly onChange: (value: WeekDraft) => void;
  readonly maxMinutes: number;
  readonly emptyLabel: string;
}) {
  const { t, locale } = useI18n();
  const setDay = (index: number, day: readonly ShiftDraft[]) =>
    props.onChange(props.value.map((current, i) => (i === index ? day : current)));
  const issueOf = (day: readonly ShiftDraft[]) => {
    const frame = day.map(({ start, end }) => [timeMinute(start), timeMinute(end)] as const);
    const complete = frame.every(
      (shift): shift is readonly [number, number] =>
        shift[0] !== undefined && shift[1] !== undefined,
    );
    return complete ? frameIssue(frame, props.maxMinutes) : undefined;
  };

  return (
    <Table.ScrollContainer minWidth={520}>
      <Table verticalSpacing="xs">
        <Table.Tbody>
          {props.value.map((day, index) => {
            const name = isoWeekdayName(index + 1, locale);
            const issue = issueOf(day);
            return (
              <Table.Tr key={name}>
                <Table.Th w={120}>{name}</Table.Th>
                <Table.Td>
                  <Stack gap="xs">
                    {day.length === 0 && (
                      <Text size="sm" c="dimmed">
                        {props.emptyLabel}
                      </Text>
                    )}
                    {day.map((shift, position) => (
                      <Group key={position} gap="xs" wrap="nowrap">
                        {(['start', 'end'] as const).map((edge) => (
                          <TextInput
                            key={edge}
                            type="time"
                            step={300}
                            aria-label={`${name} ${t(`schedule.shift.${edge}`)} ${position + 1}`}
                            value={shift[edge]}
                            onChange={(event) =>
                              setDay(
                                index,
                                day.map((item, i) =>
                                  i === position
                                    ? { ...item, [edge]: event.currentTarget.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        ))}
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          size="lg"
                          aria-label={`${t('schedule.shift.remove')} ${name} ${position + 1}`}
                          onClick={() =>
                            setDay(
                              index,
                              day.filter((_, i) => i !== position),
                            )
                          }
                        >
                          <IconTrash size={18} stroke={1.75} aria-hidden />
                        </ActionIcon>
                      </Group>
                    ))}
                    {issue && (
                      <Text size="sm" c="red">
                        {t(issue)}
                      </Text>
                    )}
                    <Group>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        leftSection={<IconPlus size={16} stroke={1.75} aria-hidden />}
                        disabled={day.length >= MAX_SHIFTS}
                        aria-label={`${t('schedule.shift.add')} ${name}`}
                        onClick={() => setDay(index, [...day, { start: '', end: '' }])}
                      >
                        {t('schedule.shift.add')}
                      </Button>
                    </Group>
                  </Stack>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

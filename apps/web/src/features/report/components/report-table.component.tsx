import { Badge, Table } from '@mantine/core';
import type { ReactNode } from 'react';
import { formatDays } from '../../../i18n/format.helper';
import type { Locale, MessageKey } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import type { ReportResult } from '../report.client';
import { kindKeys } from '../report.helper';

type Translate = (key: MessageKey) => string;

interface Sheet {
  readonly head: readonly MessageKey[];
  readonly body: readonly { readonly key: string; readonly cells: readonly ReactNode[] }[];
}

const who: readonly MessageKey[] = ['employee.field.code', 'employee.field.fullName'];

/** Day and month of `YYYY-MM-DD` by string surgery: the year of a birthday is never shown. */
const dayMonth = (value: string) => `${value.slice(8, 10)}/${value.slice(5, 7)}`;

function sheetOf(result: ReportResult, t: Translate, locale: Locale): Sheet {
  const days = (minutes: number) => `${formatDays(minutes, locale)} ${t('attendance.unitDay')}`;
  const counted = (count: number, minutes: number) =>
    `${count} ${t('attendance.unitTimes')} · ${minutes} ${t('attendance.unitMinute')}`;
  const state = (value: 'open' | 'closed') => (
    <Badge color={value === 'closed' ? 'gray' : 'green'} variant="light">
      {t(value === 'closed' ? 'attendance.state.closed' : 'attendance.state.open')}
    </Badge>
  );
  switch (result.kind) {
    case 'attendance':
      return {
        head: [
          ...who,
          'report.col.month',
          'attendance.periodState',
          'attendance.scheduled',
          'attendance.paid',
          'attendance.adjustment',
          'attendance.holiday',
          'attendance.unpaid',
          'attendance.annual',
          'attendance.wfh',
          'attendance.late',
          'attendance.early',
        ],
        body: result.rows.map((r) => ({
          key: `${r.employeeId}-${r.month}`,
          cells: [
            r.employeeCode,
            r.employeeName,
            r.month,
            state(r.periodState),
            days(r.scheduledMinutes),
            days(r.paidMinutes),
            `${r.adjustmentMinutes} ${t('attendance.unitMinute')}`,
            days(r.paidHolidayMinutes),
            days(r.unpaidMinutes),
            days(r.annualLeaveMinutes),
            `${r.wfhDays} ${t('attendance.unitDay')}`,
            counted(r.lateCount, r.lateMinutes),
            counted(r.earlyCount, r.earlyMinutes),
          ],
        })),
      };
    case 'late-early':
      return {
        head: [
          ...who,
          'report.col.month',
          'attendance.periodState',
          'attendance.late',
          'attendance.early',
        ],
        body: result.rows.map((r) => ({
          key: `${r.employeeId}-${r.month}`,
          cells: [
            r.employeeCode,
            r.employeeName,
            r.month,
            state(r.periodState),
            counted(r.lateCount, r.lateMinutes),
            counted(r.earlyCount, r.earlyMinutes),
          ],
        })),
      };
    case 'wfh':
      return {
        head: [
          ...who,
          'report.col.month',
          'attendance.periodState',
          'attendance.wfh',
          'report.col.overLimit',
        ],
        body: result.rows.map((r) => ({
          key: `${r.employeeId}-${r.month}`,
          cells: [
            r.employeeCode,
            r.employeeName,
            r.month,
            state(r.periodState),
            `${r.wfhDays} ${t('attendance.unitDay')}`,
            r.overLimit ? (
              <Badge color="orange" variant="light">
                {t('report.overLimit')}
              </Badge>
            ) : (
              '—'
            ),
          ],
        })),
      };
    case 'leave':
      return {
        head: [
          ...who,
          'leave.annualRate',
          'leave.entitled',
          'leave.used',
          'leave.future',
          'leave.pending',
          'leave.available',
        ],
        body: result.rows.map((r) => ({
          key: r.employeeId,
          cells: [
            r.employeeCode,
            r.employeeName,
            r.annualMinutes === null ? '—' : days(r.annualMinutes),
            days(r.entitledMinutes),
            days(r.usedMinutes),
            days(r.futureApprovedMinutes),
            days(r.pendingMinutes),
            days(r.availableMinutes),
          ],
        })),
      };
    case 'seniority':
      return {
        head: [...who, 'employee.field.hiredOn', 'report.col.seniority', 'report.col.totalDays'],
        body: result.rows.map((r) => ({
          key: r.employeeId,
          cells: [
            r.employeeCode,
            r.employeeName,
            `${r.hiredOn.slice(8, 10)}/${r.hiredOn.slice(5, 7)}/${r.hiredOn.slice(0, 4)}`,
            `${r.years} ${t('report.unit.year')} ${r.months} ${t('report.unit.month')} ${r.days} ${t('attendance.unitDay')}`,
            `${r.totalDays} ${t('attendance.unitDay')}`,
          ],
        })),
      };
    case 'birthday':
      return {
        head: [...who, 'report.col.month', 'report.col.birthday'],
        body: result.rows.map((r) => ({
          key: `${r.employeeId}-${r.month}`,
          cells: [r.employeeCode, r.employeeName, r.month, dayMonth(r.birthdayOn)],
        })),
      };
  }
}

/** The rows of one report page, exactly the fields the API returned for it (no PII added). */
export function ReportTable(props: { readonly result: ReportResult }) {
  const { t, locale } = useI18n();
  const sheet = sheetOf(props.result, t, locale);
  return (
    <Table.ScrollContainer minWidth={720}>
      <Table striped verticalSpacing="xs" aria-label={t(kindKeys[props.result.kind])}>
        <Table.Thead>
          <Table.Tr>
            {sheet.head.map((key) => (
              <Table.Th key={key}>{t(key)}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sheet.body.map((row) => (
            <Table.Tr key={row.key}>
              {row.cells.map((cell, index) => (
                <Table.Td key={sheet.head[index]}>{cell}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

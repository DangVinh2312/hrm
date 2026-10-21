import type { MessageKey } from '../../i18n/i18n.helper';
import type { ReportFilter, ReportKind } from './report.client';

export const reportKinds: readonly ReportKind[] = [
  'attendance',
  'late-early',
  'wfh',
  'leave',
  'seniority',
  'birthday',
];

export const kindKeys: Readonly<Record<ReportKind, MessageKey>> = {
  attendance: 'report.kind.attendance',
  'late-early': 'report.kind.lateEarly',
  wfh: 'report.kind.wfh',
  leave: 'report.kind.leave',
  seniority: 'report.kind.seniority',
  birthday: 'report.kind.birthday',
};

export const isReportKind = (value: string): value is ReportKind =>
  (reportKinds as readonly string[]).includes(value);

/** The API refuses a range over 12 months (design §11); checked here so the user sees why. */
export const REPORT_MAX_MONTHS = 12;

export interface ReportInputs {
  readonly kind: ReportKind;
  readonly from: string;
  readonly to: string;
  readonly asOn: string;
}

const monthPattern = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** A regex alone accepts 2026-02-31; the round trip through UTC does not. */
const isCalendarDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
};

const monthIndex = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7));

/** Business today (ADR 0018: Asia/Ho_Chi_Minh) as `YYYY-MM-DD`, whatever the machine's timezone. */
export const businessToday = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

export const initialInputs = (): ReportInputs => {
  const today = businessToday();
  return { kind: 'attendance', from: today.slice(0, 7), to: today.slice(0, 7), asOn: today };
};

/** The query of the chosen report, or the locale key of what is wrong with the inputs. */
export function filterOf(inputs: ReportInputs): ReportFilter | MessageKey {
  if (inputs.kind === 'leave' || inputs.kind === 'seniority') {
    return isCalendarDate(inputs.asOn)
      ? { kind: inputs.kind, asOn: inputs.asOn }
      : 'report.error.date';
  }
  if (!monthPattern.test(inputs.from) || !monthPattern.test(inputs.to)) return 'report.error.month';
  const span = monthIndex(inputs.to) - monthIndex(inputs.from) + 1;
  if (span < 1) return 'report.error.order';
  if (span > REPORT_MAX_MONTHS) return 'report.error.span';
  return { kind: inputs.kind, from: inputs.from, to: inputs.to };
}

export const isFilter = (value: ReportFilter | MessageKey): value is ReportFilter =>
  typeof value !== 'string';

/** Hands a downloaded file to the browser and releases its object URL right away. */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

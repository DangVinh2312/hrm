/**
 * The one reader of schedules for the request, attendance and report statements (ADR-19): SQL
 * fragments that return the stored rows as JSON inside the caller's statement (same snapshot,
 * same scope), and the conversion of that JSON into {@link ScheduleFacts}.
 */
import type {
  EmployeeFrames,
  Frame,
  MakeupDay,
  ScheduleFacts,
  ScheduleVersion,
  Shift,
} from './work-schedule.helper.js';

/** `[weekday, start, end]` of one stored shift, ordered by weekday then position. */
export type StoredShift = readonly [weekday: number, start: number, end: number];

export interface StoredVersion {
  readonly from: string;
  readonly shifts: readonly StoredShift[];
}

export interface StoredFrames {
  readonly id: string;
  readonly from: string;
  readonly to: string | null;
  readonly shifts: readonly StoredShift[];
}

export interface StoredMakeup extends MakeupDay {
  readonly date: string;
}

export interface StoredSchedule {
  readonly versions: readonly StoredVersion[];
  readonly frames: readonly StoredFrames[];
  readonly holidays: readonly string[];
  readonly makeupDays: readonly StoredMakeup[];
}

const day = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

const shiftsSql = (table: string, parent: string) =>
  `COALESCE((SELECT json_agg(json_build_array(s.weekday, s.start_minute, s.end_minute)
                    ORDER BY s.weekday, s.position)
               FROM ${table} s WHERE s.schedule_id = ${parent}), '[]'::json)`;

/**
 * JSON array (SQL fragment) of the company schedule versions in force on some day of [`first`,
 * `next`): the one in force on `first` and every later one starting before `next`.
 */
export const scheduleVersionsSql = (first: string, next: string) =>
  `COALESCE((SELECT json_agg(json_build_object('from', ${day('w.effective_from')},
                    'shifts', ${shiftsSql('work_schedule_shift', 'w.id')}) ORDER BY w.effective_from)
               FROM work_schedule w
              WHERE w.effective_from < ${next}
                AND w.effective_from >= (SELECT max(v.effective_from) FROM work_schedule v
                                          WHERE v.effective_from <= ${first})), '[]'::json)`;

/** JSON array (SQL fragment) of the frames of employee `employee` covering some day of [`first`, `next`). */
export const employeeFramesSql = (employee: string, first: string, next: string) =>
  `COALESCE((SELECT json_agg(json_build_object('id', o.id, 'from', ${day('o.valid_from')}, 'to', ${day('o.valid_to')},
                    'shifts', ${shiftsSql('employee_schedule_shift', 'o.id')}) ORDER BY o.valid_from)
               FROM employee_schedule o
              WHERE o.employee_id = ${employee} AND o.valid_from < ${next}
                AND (o.valid_to IS NULL OR o.valid_to >= ${first})), '[]'::json)`;

function byWeekday(shifts: readonly StoredShift[]): Map<number, Frame> {
  const days = new Map<number, Shift[]>();
  for (const [weekday, start, end] of shifts)
    days.set(weekday, [...(days.get(weekday) ?? []), [start, end]]);
  return days;
}

/** Seven frames, Monday first; a weekday without shifts is empty. */
export const weekFrames = (shifts: readonly StoredShift[]): Frame[] => {
  const days = byWeekday(shifts);
  return [1, 2, 3, 4, 5, 6, 7].map((w) => days.get(w) ?? []);
};

/** The stored form of seven frames, as {@link weekFrames} reads it back. */
export const storedShifts = (days: readonly Frame[]): StoredShift[] =>
  days.flatMap((frame, index) => frame.map(([start, end]): StoredShift => [index + 1, start, end]));

export const scheduleVersions = (stored: readonly StoredVersion[]): ScheduleVersion[] =>
  stored.map((v) => ({ effectiveFrom: v.from, days: weekFrames(v.shifts) }));

export const employeeFrames = (stored: readonly StoredFrames[]): EmployeeFrames[] =>
  stored.map((o) => ({ validFrom: o.from, validTo: o.to, days: byWeekday(o.shifts) }));

export const scheduleFacts = (
  versions: readonly ScheduleVersion[],
  stored: Omit<StoredSchedule, 'versions'>,
): ScheduleFacts => ({
  versions,
  overrides: employeeFrames(stored.frames),
  paidHolidays: new Set(stored.holidays),
  makeupDays: new Map(
    stored.makeupDays.map((m) => [m.date, { asWeekday: m.asWeekday, frameSource: m.frameSource }]),
  ),
});

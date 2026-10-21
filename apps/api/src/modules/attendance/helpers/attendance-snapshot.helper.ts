/**
 * Snapshot of a closed attendance month (D07, ADR 0018 bổ sung T9 and 2026-10-22) and its SHA-256.
 *
 * The column is `jsonb`, which does not keep key order, so the hash cannot be recomputed from the
 * text that went in. Instead the hash is defined over ONE canonical serialization per format: the
 * snapshot rebuilt from its values in the fixed key order below and written with `JSON.stringify`.
 *  - format 1 (absent `formatVersion`; every close before `attendance.adjust`): `month`,
 *    `calendarVersion`, `employees[{employeeId, ten totals}]`. These are exactly the bytes those
 *    closes hashed, so their stored hashes stay valid and such a snapshot is read back, verified
 *    and reported as it was written (with zero adjustments), never silently rewritten.
 *  - format 2 (every close from release 15): `formatVersion: 2` first and `adjustmentMinutes`
 *    appended to the totals, so the audited adjustments of the month are under the hash.
 * A reader verifies a snapshot by parsing the jsonb it reads back and hashing the canonical form of
 * the format it declares; dropping or adding `formatVersion` changes the bytes, hence the hash.
 */
import { createHash } from 'node:crypto';
import type { AttendanceTotals } from './attendance-calculation.helper.js';

export interface SnapshotEmployee extends AttendanceTotals {
  readonly employeeId: string;
}

export interface AttendanceSnapshot {
  /** 1: written before `attendance.adjust` existed; 2: includes adjustments. */
  readonly formatVersion: 1 | 2;
  /** `YYYY-MM`. */
  readonly month: string;
  /** int8 as a decimal string. */
  readonly calendarVersion: string;
  /** In employee id order, as the close wrote them. */
  readonly employees: readonly SnapshotEmployee[];
}

/** The ten totals of format 1, in the order of its canonical serialization. */
const baseKeys = [
  'scheduledMinutes',
  'paidHolidayMinutes',
  'unpaidMinutes',
  'annualLeaveMinutes',
  'paidMinutes',
  'wfhDays',
  'lateCount',
  'lateMinutes',
  'earlyCount',
  'earlyMinutes',
] as const satisfies readonly (keyof AttendanceTotals)[];

/** Format 2 appends the adjustments to the same order. */
const adjustedKeys = [...baseKeys, 'adjustmentMinutes'] as const;

/** Totals that are signed: the paid total and the adjustments (a writer keeps the paid total >= 0). */
const signedKeys = new Set<string>(['paidMinutes', 'adjustmentMinutes']);

const keysOf = (format: 1 | 2) => (format === 2 ? adjustedKeys : baseKeys);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored employee entry (jsonb read-back), strictly validated and rebuilt in canonical order. */
export function parseSnapshotEmployee(value: unknown, format: 1 | 2 = 2): SnapshotEmployee {
  if (!isRecord(value) || typeof value.employeeId !== 'string')
    throw new Error('Invalid attendance snapshot entry');
  const totals: Record<string, number> = {};
  for (const key of keysOf(format)) {
    const minutes = value[key];
    if (
      typeof minutes !== 'number' ||
      !Number.isSafeInteger(minutes) ||
      (minutes < 0 && !signedKeys.has(key))
    )
      throw new Error('Invalid attendance snapshot entry');
    totals[key] = minutes;
  }
  // A format 1 entry has no adjustments: it reads as zero and keeps its own canonical form.
  if (format === 1) totals.adjustmentMinutes = 0;
  return { employeeId: value.employeeId, ...(totals as unknown as AttendanceTotals) };
}

/** A stored snapshot (the jsonb value read back) as the canonical typed document. */
export function parseSnapshot(value: unknown): AttendanceSnapshot {
  if (
    !isRecord(value) ||
    typeof value.month !== 'string' ||
    typeof value.calendarVersion !== 'string' ||
    !Array.isArray(value.employees) ||
    (value.formatVersion !== undefined && value.formatVersion !== 2)
  )
    throw new Error('Invalid attendance snapshot');
  const format = value.formatVersion === 2 ? 2 : 1;
  return build(
    format,
    value.month,
    value.calendarVersion,
    value.employees.map((employee) => parseSnapshotEmployee(employee, format)),
  );
}

function build(
  formatVersion: 1 | 2,
  month: string,
  calendarVersion: string,
  employees: readonly SnapshotEmployee[],
): AttendanceSnapshot {
  return {
    formatVersion,
    month,
    calendarVersion,
    employees: employees.map((employee) => {
      const { employeeId, ...totals } = employee;
      const ordered: Record<string, number> = {};
      for (const key of adjustedKeys) ordered[key] = totals[key];
      return { employeeId, ...(ordered as unknown as AttendanceTotals) };
    }),
  };
}

/** The snapshot document of a close (always the newest format): the one place that fixes it. */
export const buildSnapshot = (
  month: string,
  calendarVersion: string,
  employees: readonly SnapshotEmployee[],
): AttendanceSnapshot => build(2, month, calendarVersion, employees);

/** The bytes that are hashed, and the value stored, in the canonical key order of its format. */
export function canonicalSnapshot(snapshot: AttendanceSnapshot): string {
  const keys = keysOf(snapshot.formatVersion);
  return JSON.stringify({
    ...(snapshot.formatVersion === 2 ? { formatVersion: 2 } : {}),
    month: snapshot.month,
    calendarVersion: snapshot.calendarVersion,
    employees: snapshot.employees.map((employee) => ({
      employeeId: employee.employeeId,
      ...Object.fromEntries(keys.map((key) => [key, employee[key]])),
    })),
  });
}

/** SHA-256 hex of the canonical serialization; `snapshot` must come from build/parseSnapshot. */
export const snapshotHash = (snapshot: AttendanceSnapshot): string =>
  createHash('sha256').update(canonicalSnapshot(snapshot)).digest('hex');

/**
 * Verifies the stored jsonb of a closed month against its stored hash and month; throws when the
 * document was altered, so a report never serves a snapshot it cannot prove (fail closed).
 */
export function verifiedSnapshot(month: string, stored: unknown, hash: string): AttendanceSnapshot {
  const snapshot = parseSnapshot(stored);
  if (snapshot.month !== month || snapshotHash(snapshot) !== hash)
    throw new Error('Attendance snapshot does not match its hash');
  return snapshot;
}

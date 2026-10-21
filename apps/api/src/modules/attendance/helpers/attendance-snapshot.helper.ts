/**
 * Snapshot of a closed attendance month (D07, ADR 0018 bổ sung T9) and its SHA-256.
 *
 * The column is `jsonb`, which does not keep key order, so the hash cannot be recomputed from the
 * text that went in. Instead the hash is defined over ONE canonical serialization: the snapshot
 * rebuilt from its values in the fixed key order below and written with `JSON.stringify`. That is
 * exactly the byte sequence every close has hashed so far (the object literal of `closePeriod` and
 * the result order of `attendanceTotals` are this order), so stored hashes stay valid and a
 * reader verifies a snapshot by parsing the jsonb it reads back and hashing the canonical form.
 */
import { createHash } from 'node:crypto';
import type { AttendanceTotals } from './attendance-calculation.helper.js';

export interface SnapshotEmployee extends AttendanceTotals {
  readonly employeeId: string;
}

export interface AttendanceSnapshot {
  /** `YYYY-MM`. */
  readonly month: string;
  /** int8 as a decimal string. */
  readonly calendarVersion: string;
  /** In employee id order, as the close wrote them. */
  readonly employees: readonly SnapshotEmployee[];
}

/** The totals keys in the order of the canonical serialization (= `attendanceTotals` result order). */
const totalKeys = [
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored employee entry (jsonb read-back), strictly validated and rebuilt in canonical order. */
export function parseSnapshotEmployee(value: unknown): SnapshotEmployee {
  if (!isRecord(value) || typeof value.employeeId !== 'string')
    throw new Error('Invalid attendance snapshot entry');
  const totals: Record<string, number> = {};
  for (const key of totalKeys) {
    const minutes = value[key];
    if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 0)
      throw new Error('Invalid attendance snapshot entry');
    totals[key] = minutes;
  }
  return { employeeId: value.employeeId, ...(totals as unknown as AttendanceTotals) };
}

/** A stored snapshot (the jsonb value read back) as the canonical typed document. */
export function parseSnapshot(value: unknown): AttendanceSnapshot {
  if (
    !isRecord(value) ||
    typeof value.month !== 'string' ||
    typeof value.calendarVersion !== 'string' ||
    !Array.isArray(value.employees)
  )
    throw new Error('Invalid attendance snapshot');
  return buildSnapshot(
    value.month,
    value.calendarVersion,
    value.employees.map(parseSnapshotEmployee),
  );
}

/** The snapshot document of a close: the one place that fixes the key order. */
export function buildSnapshot(
  month: string,
  calendarVersion: string,
  employees: readonly SnapshotEmployee[],
): AttendanceSnapshot {
  return {
    month,
    calendarVersion,
    employees: employees.map((employee) => {
      const { employeeId, ...totals } = employee;
      const ordered: Record<string, number> = {};
      for (const key of totalKeys) ordered[key] = totals[key];
      return { employeeId, ...(ordered as unknown as AttendanceTotals) };
    }),
  };
}

/** SHA-256 hex of the canonical serialization; `snapshot` must come from build/parseSnapshot. */
export const snapshotHash = (snapshot: AttendanceSnapshot): string =>
  createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

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

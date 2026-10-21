import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T8 `attendance.adjust` (design §5.2, §9, ADR 0017/0018 bổ sung 2026-10-22, user decision of
 * 2026-10-22). One row is one HR adjustment of the paid minutes of ONE employee on ONE day:
 *  - `minutes` is a signed delta of paid working minutes, never a per-kind correction and never a
 *    ledger entry (the leave ledger is untouched); non-zero and within one day (±1440). The rule
 *    "the paid total of the month stays >= 0" depends on other tables, so the writer checks it
 *    under lock; the CHECKs below bound what one row can say.
 *  - `reason` is mandatory short text (no control characters), `reference` optional and short.
 *    Neither is ever copied to audit or logs.
 *  - append-only: `product_data` gets SELECT and INSERT only, so an entry is never updated or
 *    deleted; a mistake is corrected by a new entry of the opposite sign (audited like the first).
 * The sheet and the snapshot of a month read the sum of its rows (work_date inside the month).
 * `hr_idempotency.operation` is widened with `attendance.adjust` (same claim table as leave.adjust).
 */
export class HrmAttendanceAdjust1792108800112 implements MigrationInterface {
  name = 'HrmAttendanceAdjust1792108800112';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      CREATE TABLE attendance_adjustment(
        id uuid PRIMARY KEY,
        employee_id uuid NOT NULL REFERENCES employee(id),
        work_date date NOT NULL CONSTRAINT ck_attendance_adjustment_date CHECK (
          work_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
        minutes integer NOT NULL CONSTRAINT ck_attendance_adjustment_minutes CHECK (
          minutes <> 0 AND minutes BETWEEN -1440 AND 1440),
        reason text COLLATE "C" NOT NULL CONSTRAINT ck_attendance_adjustment_reason CHECK (
          char_length(reason) BETWEEN 1 AND 300 AND reason !~ '[[:cntrl:]]'),
        reference text COLLATE "C" CONSTRAINT ck_attendance_adjustment_reference CHECK (
          reference IS NULL OR (char_length(reference) BETWEEN 1 AND 64 AND reference !~ '[[:cntrl:]]')),
        actor_account_id uuid NOT NULL REFERENCES app_user(id),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp()
      );
      CREATE INDEX ix_attendance_adjustment_employee ON attendance_adjustment(employee_id, work_date);
      GRANT SELECT, INSERT ON attendance_adjustment TO product_data;
      ALTER TABLE hr_idempotency
        DROP CONSTRAINT ck_hr_idempotency_operation,
        ADD CONSTRAINT ck_hr_idempotency_operation CHECK (operation IN
          ('workRequest.submit','workRequest.decide','workRequest.cancel','leave.adjust','attendance.adjust'));
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

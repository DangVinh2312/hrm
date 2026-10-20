import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T7 annual leave ledger (design §8–§9, ADR 0017/0018). Accrual is not stored: it is a pure
 * function of the hire date, status periods and `leave_rate` rows (one source, nothing to drift).
 * `leave_ledger` is append-only for the runtime (SELECT/INSERT) and holds what accrual cannot
 * derive: a `debit` per approved annual-leave segment (UNIQUE per segment, so a replay cannot
 * debit twice; the FK makes the source an annual-leave segment), its `reversal` (UNIQUE per
 * debit, same employee/date/minutes by FK), and signed `opening`/`adjustment` entries that need a
 * `reference` naming where the number comes from (D14 reconciliation source; the import itself is
 * T12, no runtime route writes them). `leave_bucket` is the per (employee, year) lock anchor of
 * spec §7.3 step 6: created with INSERT ... ON CONFLICT DO NOTHING, then locked FOR UPDATE;
 * `revision` counts the ledger writes under it (its UPDATE grant is also what allows the lock).
 * Adding the UNIQUE to `work_request_segment` is additive and holds for every existing row.
 * shortcut: the ledger row does not carry the request's employee in an FK (the segment has no
 * employee column); the only writer derives it from the locked request.
 */
export class HrmLeave1792108800109 implements MigrationInterface {
  name = 'HrmLeave1792108800109';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      ALTER TABLE work_request_segment
        ADD CONSTRAINT uq_work_request_segment_kind UNIQUE (request_id, work_date, kind);
      CREATE TABLE leave_bucket(
        employee_id uuid NOT NULL REFERENCES employee(id),
        year smallint NOT NULL CONSTRAINT ck_leave_bucket_year CHECK (year BETWEEN 1900 AND 2100),
        revision int8 NOT NULL DEFAULT 1 CONSTRAINT ck_leave_bucket_revision CHECK (revision >= 1),
        CONSTRAINT pk_leave_bucket PRIMARY KEY (employee_id, year)
      );
      CREATE TABLE leave_ledger(
        id uuid PRIMARY KEY,
        employee_id uuid NOT NULL REFERENCES employee(id),
        entry_kind text NOT NULL CONSTRAINT ck_leave_ledger_kind CHECK (entry_kind IN ('debit','reversal','opening','adjustment')),
        effective_on date NOT NULL CONSTRAINT ck_leave_ledger_date CHECK (effective_on BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
        minutes integer NOT NULL,
        source_request_id uuid,
        source_work_date date,
        source_kind text GENERATED ALWAYS AS (CASE WHEN source_request_id IS NOT NULL THEN 'annual-leave' END) STORED,
        reverses_entry_id uuid,
        reference text COLLATE "C" CONSTRAINT ck_leave_ledger_reference CHECK (char_length(reference) BETWEEN 1 AND 200),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT ck_leave_ledger_shape CHECK (
          (entry_kind = 'debit' AND minutes BETWEEN 1 AND 480 AND source_request_id IS NOT NULL
             AND source_work_date = effective_on AND reverses_entry_id IS NULL AND reference IS NULL)
          OR (entry_kind = 'reversal' AND minutes BETWEEN 1 AND 480 AND reverses_entry_id IS NOT NULL
             AND source_request_id IS NULL AND source_work_date IS NULL AND reference IS NULL)
          OR (entry_kind IN ('opening','adjustment') AND minutes <> 0 AND minutes BETWEEN -175680 AND 175680
             AND reference IS NOT NULL AND source_request_id IS NULL AND source_work_date IS NULL
             AND reverses_entry_id IS NULL)),
        CONSTRAINT uq_leave_ledger_segment UNIQUE (source_request_id, source_work_date),
        CONSTRAINT uq_leave_ledger_reverses UNIQUE (reverses_entry_id),
        CONSTRAINT uq_leave_ledger_entry UNIQUE (id, employee_id, effective_on, minutes),
        CONSTRAINT fk_leave_ledger_segment FOREIGN KEY (source_request_id, source_work_date, source_kind)
          REFERENCES work_request_segment(request_id, work_date, kind),
        CONSTRAINT fk_leave_ledger_reverses FOREIGN KEY (reverses_entry_id, employee_id, effective_on, minutes)
          REFERENCES leave_ledger(id, employee_id, effective_on, minutes)
      );
      CREATE INDEX ix_leave_ledger_employee ON leave_ledger(employee_id, effective_on);
      -- Append-only ledger; the bucket is only created and locked (revision), never deleted.
      GRANT SELECT, INSERT ON leave_ledger, leave_bucket TO product_data;
      GRANT UPDATE(revision) ON leave_bucket TO product_data;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

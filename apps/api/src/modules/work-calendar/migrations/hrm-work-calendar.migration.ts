import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T4 work calendar (ADR 0018, design §9): the standard week is code (working-time.helper.ts);
 * the database keeps only HR's dated exceptions. `work_calendar` is the singleton record the
 * permissions apply to and holds the current version; every change appends one row to
 * `work_calendar_change` with the next version, so the calendar of any version N is "latest row
 * per day with version ≤ N" and nothing is ever rewritten (D07 history). The runtime has no
 * UPDATE/DELETE on the history. Only weekdays can change: a weekend holiday would be a silent
 * no-op for working time. The anchor row is created by the sync login after the release that
 * declares `workCalendar` (hr/repositories/hr-object.repository.ts#ensureWorkCalendar).
 */
export class HrmWorkCalendar1792108800103 implements MigrationInterface {
  name = 'HrmWorkCalendar1792108800103';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      CREATE TABLE work_calendar(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        singleton boolean NOT NULL DEFAULT true CHECK (singleton),
        version int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
        CONSTRAINT uq_work_calendar_singleton UNIQUE (singleton)
      );
      CREATE TABLE work_calendar_change(
        version int8 PRIMARY KEY CHECK (version >= 2),
        day date NOT NULL CHECK (day BETWEEN DATE '1900-01-01' AND DATE '2100-12-31' AND extract(isodow FROM day) < 6),
        kind text NOT NULL CHECK (kind IN ('paid_holiday','standard')),
        name text CHECK (char_length(name) BETWEEN 1 AND 200),
        changed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT ck_work_calendar_change_name CHECK ((kind = 'paid_holiday') = (name IS NOT NULL))
      );
      CREATE INDEX ix_work_calendar_change_day ON work_calendar_change(day, version);
      GRANT SELECT ON work_calendar,work_calendar_change TO product_data;
      -- version is the optimistic-concurrency column and the one UPDATE column the row lock needs.
      GRANT UPDATE(version) ON work_calendar TO product_data;
      GRANT INSERT ON work_calendar_change TO product_data;
      GRANT SELECT, INSERT ON work_calendar TO product_sync;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

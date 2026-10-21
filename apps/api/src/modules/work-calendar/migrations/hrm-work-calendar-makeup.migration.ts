import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T4 makeup workdays (ADR 0018, design §9): a Saturday/Sunday HR marks as a full workday is one
 * more `kind` of the same append-only history (`makeup_workday`, no name), so it is versioned,
 * fenced and audited exactly like a holiday and needs no new grant. The weekday rule moves from
 * the `day` column into the kind: holidays stay Monday–Friday, makeup days only Saturday/Sunday,
 * `standard` (back to the standard week) on any day. Since a row has one kind, a date can never be
 * both. Every existing row is a weekday `paid_holiday`/`standard`, so the new CHECKs hold.
 */
export class HrmWorkCalendarMakeup1792108800104 implements MigrationInterface {
  name = 'HrmWorkCalendarMakeup1792108800104';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      ALTER TABLE work_calendar_change
        DROP CONSTRAINT work_calendar_change_day_check,
        DROP CONSTRAINT work_calendar_change_kind_check,
        ADD CONSTRAINT ck_work_calendar_change_day
          CHECK (day BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
        ADD CONSTRAINT ck_work_calendar_change_kind CHECK (
          kind = 'standard'
          OR (kind = 'paid_holiday' AND extract(isodow FROM day) < 6)
          OR (kind = 'makeup_workday' AND extract(isodow FROM day) >= 6)
        );
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

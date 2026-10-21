import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T8 attendance (design §8–§9, ADR 0017/0018). The monthly sheet is not stored: it is a pure
 * function of the hire/leaving dates, the calendar version and the segments of `approved`
 * requests, so the request row is the only source of an effect and an approval or a later
 * cancellation cannot leave a second copy behind. What cannot be derived is stored here:
 *  - `wfh_month_counter`: the approved WFH days of an employee in the month of the WFH day (D04).
 *    It is the lock anchor of spec §7.3 step 6 (INSERT ... ON CONFLICT DO NOTHING, then
 *    SELECT ... FOR UPDATE, so a month with no row yet is still serialized) and is only moved by
 *    the approval transaction that holds it; `approved_count >= 0` guards a double release.
 *  - `attendance_period`: one row per calendar month, company wide (D07). `open` is also the state
 *    of a month with no row. Writers of requests, effects and calendar days take it FOR SHARE
 *    (after upserting the row, so a month with no row is still fenced); HR close/reopen take it
 *    FOR UPDATE. A close stores the sheet snapshot of the month and its SHA-256, so the state of
 *    the closed month is reproducible whatever happens to the inputs afterwards.
 *  - `attendance_period_event`: append-only history of every close/reopen with the actor and the
 *    mandatory reason of a reopen (D07).
 * shortcut: the snapshot is one jsonb document with the totals of every employee of the month;
 * move it to a row per employee if a month grows past a few thousand employees.
 */
export class HrmAttendance1792108800110 implements MigrationInterface {
  name = 'HrmAttendance1792108800110';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      CREATE TABLE wfh_month_counter(
        employee_id uuid NOT NULL REFERENCES employee(id),
        month date NOT NULL CONSTRAINT ck_wfh_month_counter_month CHECK (
          EXTRACT(day FROM month) = 1 AND month BETWEEN DATE '1900-01-01' AND DATE '2100-12-01'),
        approved_count integer NOT NULL DEFAULT 0 CONSTRAINT ck_wfh_month_counter_count CHECK (approved_count BETWEEN 0 AND 31),
        revision int8 NOT NULL DEFAULT 1 CONSTRAINT ck_wfh_month_counter_revision CHECK (revision >= 1),
        CONSTRAINT pk_wfh_month_counter PRIMARY KEY (employee_id, month)
      );
      CREATE TABLE attendance_period(
        month date PRIMARY KEY CONSTRAINT ck_attendance_period_month CHECK (
          EXTRACT(day FROM month) = 1 AND month BETWEEN DATE '1900-01-01' AND DATE '2100-12-01'),
        state text NOT NULL DEFAULT 'open' CONSTRAINT ck_attendance_period_state CHECK (state IN ('open','closed')),
        version int8 NOT NULL DEFAULT 1 CONSTRAINT ck_attendance_period_version CHECK (version >= 1),
        snapshot jsonb,
        snapshot_hash text COLLATE "C" CONSTRAINT ck_attendance_period_hash CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT ck_attendance_period_snapshot CHECK (
          (state = 'closed') = (snapshot IS NOT NULL) AND (state = 'closed') = (snapshot_hash IS NOT NULL))
      );
      CREATE TABLE attendance_period_event(
        id uuid PRIMARY KEY,
        month date NOT NULL REFERENCES attendance_period(month),
        version int8 NOT NULL CONSTRAINT ck_attendance_period_event_version CHECK (version >= 2),
        event text NOT NULL CONSTRAINT ck_attendance_period_event_kind CHECK (event IN ('close','reopen')),
        reason text COLLATE "C" CONSTRAINT ck_attendance_period_event_reason CHECK (char_length(reason) BETWEEN 1 AND 1000),
        snapshot_hash text COLLATE "C" CONSTRAINT ck_attendance_period_event_hash CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
        actor_account_id uuid NOT NULL REFERENCES app_user(id),
        occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT ck_attendance_period_event_shape CHECK (
          (event = 'close' AND reason IS NULL AND snapshot_hash IS NOT NULL)
          OR (event = 'reopen' AND reason IS NOT NULL AND snapshot_hash IS NULL)),
        CONSTRAINT uq_attendance_period_event_version UNIQUE (month, version)
      );
      -- A counter and a period row are created and locked by the approval/submit transaction; the
      -- history is append-only. No DELETE anywhere.
      GRANT SELECT, INSERT ON wfh_month_counter, attendance_period, attendance_period_event TO product_data;
      GRANT UPDATE(approved_count, revision) ON wfh_month_counter TO product_data;
      GRANT UPDATE(state, version, snapshot, snapshot_hash) ON attendance_period TO product_data;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

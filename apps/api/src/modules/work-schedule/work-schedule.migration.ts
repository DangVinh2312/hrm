import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Working hours as data (ADR-19): company schedule versions and employee frames, each a list of
 * at most three shifts per ISO weekday. The first version, effective from 1900-01-01, is the
 * week the code used to hard-code, so every existing day keeps its hours. Makeup days name the
 * weekday whose hours they take (existing ones: Monday, company hours); holidays and makeup days
 * are no longer tied to a weekday, the schedule version in force decides. Request segments and
 * ledger entries get generic bounds: which intervals are valid depends on the person's frame of
 * that day, which only the code knows. Order and overlap of shifts are checked by the code too.
 */
export class WorkSchedule1792108800007 implements MigrationInterface {
  name = 'WorkSchedule1792108800007';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE public.work_schedule(
        id uuid PRIMARY KEY,
        effective_from date NOT NULL CONSTRAINT ck_work_schedule_effective
          CHECK (effective_from BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT uq_work_schedule_effective UNIQUE (effective_from)
      );
      CREATE TABLE public.work_schedule_shift(
        schedule_id uuid NOT NULL REFERENCES public.work_schedule(id) ON DELETE CASCADE,
        weekday smallint NOT NULL CONSTRAINT ck_work_schedule_shift_weekday CHECK (weekday BETWEEN 1 AND 7),
        position smallint NOT NULL CONSTRAINT ck_work_schedule_shift_position CHECK (position BETWEEN 1 AND 3),
        start_minute smallint NOT NULL,
        end_minute smallint NOT NULL,
        CONSTRAINT pk_work_schedule_shift PRIMARY KEY (schedule_id, weekday, position),
        CONSTRAINT ck_work_schedule_shift_bounds CHECK (
          start_minute >= 0 AND start_minute < end_minute AND end_minute <= 1440
          AND start_minute % 5 = 0 AND end_minute % 5 = 0)
      );
      CREATE TABLE public.employee_schedule(
        id uuid PRIMARY KEY,
        employee_id uuid NOT NULL REFERENCES public.employee(id),
        valid_from date NOT NULL CONSTRAINT ck_employee_schedule_from
          CHECK (valid_from BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
        valid_to date,
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT ck_employee_schedule_range CHECK (valid_to IS NULL OR valid_to BETWEEN valid_from AND DATE '2100-12-31'),
        CONSTRAINT uq_employee_schedule_from UNIQUE (employee_id, valid_from)
      );
      CREATE TABLE public.employee_schedule_shift(
        schedule_id uuid NOT NULL REFERENCES public.employee_schedule(id) ON DELETE CASCADE,
        weekday smallint NOT NULL CONSTRAINT ck_employee_schedule_shift_weekday CHECK (weekday BETWEEN 1 AND 7),
        position smallint NOT NULL CONSTRAINT ck_employee_schedule_shift_position CHECK (position BETWEEN 1 AND 3),
        start_minute smallint NOT NULL,
        end_minute smallint NOT NULL,
        CONSTRAINT pk_employee_schedule_shift PRIMARY KEY (schedule_id, weekday, position),
        CONSTRAINT ck_employee_schedule_shift_bounds CHECK (
          start_minute >= 0 AND start_minute < end_minute AND end_minute <= 1440
          AND start_minute % 5 = 0 AND end_minute % 5 = 0)
      );

      WITH seed AS (
        INSERT INTO public.work_schedule(id, effective_from) VALUES (gen_random_uuid(), DATE '1900-01-01')
        RETURNING id
      )
      INSERT INTO public.work_schedule_shift(schedule_id, weekday, position, start_minute, end_minute)
      SELECT seed.id, w, s.position, s.start_minute, s.end_minute
        FROM seed, generate_series(1, 5) w, (VALUES (1, 540, 780), (2, 840, 1080)) s(position, start_minute, end_minute);

      ALTER TABLE public.work_calendar_change
        ADD COLUMN as_weekday smallint CONSTRAINT ck_work_calendar_change_as_weekday CHECK (as_weekday BETWEEN 1 AND 7),
        ADD COLUMN frame_source text CONSTRAINT ck_work_calendar_change_frame_source CHECK (frame_source IN ('company','employee'));
      UPDATE public.work_calendar_change SET as_weekday = 1, frame_source = 'company' WHERE kind = 'makeup_workday';
      ALTER TABLE public.work_calendar_change
        DROP CONSTRAINT ck_work_calendar_change_kind,
        ADD CONSTRAINT ck_work_calendar_change_kind CHECK (kind IN ('standard','paid_holiday','makeup_workday')),
        ADD CONSTRAINT ck_work_calendar_change_makeup CHECK (
          (kind = 'makeup_workday') = (as_weekday IS NOT NULL)
          AND (kind = 'makeup_workday') = (frame_source IS NOT NULL));

      ALTER TABLE public.work_request_segment
        DROP CONSTRAINT ck_work_request_segment_slot,
        ADD CONSTRAINT ck_work_request_segment_minutes CHECK (
          start_minute >= 0 AND start_minute < end_minute AND end_minute <= 1440
          AND minutes BETWEEN 1 AND 720
          AND CASE WHEN kind IN ('late-arrival','early-departure') THEN minutes = end_minute - start_minute
                   ELSE minutes <= end_minute - start_minute END);

      ALTER TABLE public.leave_ledger
        DROP CONSTRAINT ck_leave_ledger_shape,
        ADD CONSTRAINT ck_leave_ledger_shape CHECK (
          (entry_kind = 'debit' AND minutes BETWEEN 1 AND 720 AND source_request_id IS NOT NULL
             AND source_work_date = effective_on AND reverses_entry_id IS NULL AND reference IS NULL)
          OR (entry_kind = 'reversal' AND minutes BETWEEN 1 AND 720 AND reverses_entry_id IS NOT NULL
             AND source_request_id IS NULL AND source_work_date IS NULL AND reference IS NULL)
          OR (entry_kind IN ('opening','adjustment') AND minutes <> 0 AND minutes BETWEEN -175680 AND 175680
             AND reference IS NOT NULL AND source_request_id IS NULL AND source_work_date IS NULL
             AND reverses_entry_id IS NULL));

      -- Versions and frames that are not in force yet are replaced by delete and insert; one in
      -- force only gets its end date set. Shift rows go with their parent (cascade).
      GRANT SELECT, INSERT, DELETE ON public.work_schedule, public.employee_schedule TO product_data;
      GRANT SELECT, INSERT ON public.work_schedule_shift, public.employee_schedule_shift TO product_data;
      GRANT UPDATE (valid_to) ON public.employee_schedule TO product_data;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error('Work schedule requires an explicit restore; automatic downgrade is disabled'),
    );
  }
}

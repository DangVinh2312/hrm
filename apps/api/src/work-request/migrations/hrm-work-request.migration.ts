import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T5 submit (ADR 0017/0018, design §6–§8): the request's reason, its immutable segments and the
 * idempotency claims. Segments repeat the request kind so the slot rule of each kind is a CHECK
 * here (the composite FK keeps the copy equal to the request); the runtime only appends segments
 * and claims, and never updates kind, reason or segments (D06: no edit, cancel + resubmit).
 * Adding NOT NULL `reason` fails on a table with rows: no route wrote requests before T5, so any
 * existing row needs a reviewed mapping first. Overlap, one late/early per day and probation
 * depend on other rows or tables and are checked under the employee lock, not by constraints.
 */
export class HrmWorkRequest1792108800106 implements MigrationInterface {
  name = 'HrmWorkRequest1792108800106';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      ALTER TABLE work_request
        ADD COLUMN reason text NOT NULL CONSTRAINT ck_work_request_reason CHECK (char_length(reason) BETWEEN 1 AND 1000),
        ADD CONSTRAINT uq_work_request_kind UNIQUE (id, kind);
      CREATE TABLE work_request_segment(
        request_id uuid NOT NULL,
        kind text NOT NULL,
        work_date date NOT NULL CONSTRAINT ck_work_request_segment_date CHECK (work_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
        start_minute smallint NOT NULL,
        end_minute smallint NOT NULL,
        minutes smallint NOT NULL,
        CONSTRAINT pk_work_request_segment PRIMARY KEY (request_id, work_date),
        CONSTRAINT fk_work_request_segment_request FOREIGN KEY (request_id, kind) REFERENCES work_request(id, kind),
        CONSTRAINT ck_work_request_segment_slot CHECK (
          (kind IN ('annual-leave','unpaid-leave') AND (start_minute, end_minute, minutes) IN
            ((540,660,120),(660,780,120),(840,960,120),(960,1080,120),(540,780,240),(840,1080,240),(540,1080,480)))
          OR (kind = 'wfh' AND start_minute = 540 AND end_minute = 1080 AND minutes = 480)
          OR (kind = 'late-arrival' AND minutes = end_minute - start_minute
              AND ((start_minute = 540 AND end_minute BETWEEN 541 AND 780) OR (start_minute = 840 AND end_minute BETWEEN 841 AND 1079)))
          OR (kind = 'early-departure' AND minutes = end_minute - start_minute
              AND ((end_minute = 780 AND start_minute BETWEEN 541 AND 779) OR (end_minute = 1080 AND start_minute BETWEEN 841 AND 1079)))
        )
      );
      CREATE INDEX ix_work_request_segment_date ON work_request_segment(work_date, request_id);
      CREATE TABLE hr_idempotency(
        actor_id uuid NOT NULL REFERENCES app_user(id),
        operation text NOT NULL CONSTRAINT ck_hr_idempotency_operation CHECK (operation IN ('workRequest.submit')),
        key uuid NOT NULL,
        payload_hash text COLLATE "C" NOT NULL CONSTRAINT ck_hr_idempotency_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        target_id uuid NOT NULL,
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT pk_hr_idempotency PRIMARY KEY (actor_id, operation, key)
      );
      -- Append-only for the runtime; retention purge (7 days, ADR 0017 §4) is an offline task.
      GRANT SELECT, INSERT ON work_request_segment, hr_idempotency TO product_data;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

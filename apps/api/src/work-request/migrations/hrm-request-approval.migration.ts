import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T6 decisions (design §6.2–§6.3, D08, ADR 0017 §4): the approver's reason on a decision
 * (required to reject, so a rejected request always says why) and decide claims in the
 * idempotency table. Decisions stay append-only for the runtime (INSERT/SELECT since migration
 * 100); the table-level INSERT grant covers the new column. Fails closed on a database that holds
 * a user reject without reason: no route wrote one before T6, so such a row needs a reviewed
 * mapping first.
 */
export class HrmRequestApproval1792108800107 implements MigrationInterface {
  name = 'HrmRequestApproval1792108800107';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      ALTER TABLE request_decision
        ADD COLUMN reason text CONSTRAINT ck_request_decision_reason CHECK (char_length(reason) BETWEEN 1 AND 1000),
        ADD CONSTRAINT ck_request_decision_reject_reason CHECK (decision <> 'reject' OR reason IS NOT NULL);
      ALTER TABLE hr_idempotency
        DROP CONSTRAINT ck_hr_idempotency_operation,
        ADD CONSTRAINT ck_hr_idempotency_operation CHECK (operation IN ('workRequest.submit','workRequest.decide'));
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

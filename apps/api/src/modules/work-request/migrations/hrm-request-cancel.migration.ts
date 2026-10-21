import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T8 part B (design §6.2 `cancel`/`cancel_approved`, §7.4, D06/D07, ADR 0017): the idempotency
 * claims of a cancellation (`workRequest.cancel`, owner or HR) and of an HR leave adjustment
 * (`leave.adjust`). Nothing else changes: the cancelled state, the `cancel` decision stage, the
 * `reversal` ledger entry (UNIQUE per debit) and the WFH counter decrement already have their
 * columns, CHECKs and grants from migrations 100, 109 and 110, so no new privilege is needed.
 */
export class HrmRequestCancel1792108800111 implements MigrationInterface {
  name = 'HrmRequestCancel1792108800111';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      ALTER TABLE hr_idempotency
        DROP CONSTRAINT ck_hr_idempotency_operation,
        ADD CONSTRAINT ck_hr_idempotency_operation CHECK (operation IN
          ('workRequest.submit','workRequest.decide','workRequest.cancel','leave.adjust'));
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

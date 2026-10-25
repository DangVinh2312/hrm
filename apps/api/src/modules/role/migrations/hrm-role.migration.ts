import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Role matrix anchor (ADR 0041 §3, ADR 0046). `role_anchor` is the singleton record the
 * `role.*` permissions apply to (like `setting_anchor`), created by the sync login after the
 * release that declares the resource (`ensureRole`). The role and grant rows themselves stay in
 * `role_definition` / `policy_rule`; this migration adds no column to them and no constraint on
 * runtime rows (that is a later forward migration with the write path).
 */
export class HrmRole1792108800114 implements MigrationInterface {
  name = 'HrmRole1792108800114';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      CREATE TABLE role_anchor(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        singleton boolean NOT NULL DEFAULT true CHECK (singleton),
        CONSTRAINT uq_role_anchor_singleton UNIQUE (singleton)
      );
      GRANT SELECT ON role_anchor TO product_data;
      GRANT SELECT, INSERT ON role_anchor TO product_sync;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

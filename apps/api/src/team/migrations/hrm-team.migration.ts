import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T3 team writes (ADR 0016 §5): the data login creates and renames teams; membership and lead
 * rows stay with the authority login (exclusive fence). `version` is the optimistic-concurrency
 * column and the one UPDATE column each login needs to lock the team row (ADR 0017).
 */
export class HrmTeam1792108800102 implements MigrationInterface {
  name = 'HrmTeam1792108800102';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      ALTER TABLE team ADD COLUMN version int8 NOT NULL DEFAULT 1 CONSTRAINT ck_team_version CHECK (version >= 1);
      CREATE UNIQUE INDEX uq_team_name ON team (lower(name));
      GRANT INSERT(id,object_id,name) ON team TO product_data;
      GRANT UPDATE(name,version) ON team TO product_data;
      GRANT UPDATE(version) ON team TO product_authority;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

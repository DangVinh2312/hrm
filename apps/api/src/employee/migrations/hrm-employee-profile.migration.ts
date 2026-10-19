import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Employee profile extras imported from the HR spreadsheet (ADR 0028). F1 `employee` gets
 * `job_position` and `classification`; F2 `employee_identity` gets `gender`, `phone` and
 * `work_email`. All columns are NULL for existing rows, so the migration needs no mapping and
 * cannot fail on a table with rows. CHECKs repeat the validators in employee.validator.ts.
 * No UNIQUE on phone or work email (ADR 0028): a duplicate error would reveal another record.
 * The data login gets exactly the new write columns (INSERT on employee_identity is table-wide).
 */
export class HrmEmployeeProfile1792108800105 implements MigrationInterface {
  name = 'HrmEmployeeProfile1792108800105';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      ALTER TABLE employee
        ADD COLUMN job_position text COLLATE "C",
        ADD COLUMN classification text,
        ADD CONSTRAINT ck_employee_job_position CHECK (
          job_position IS NULL
          OR (char_length(job_position) BETWEEN 1 AND 100
              AND job_position = btrim(job_position)
              AND job_position !~ '[[:cntrl:]]')),
        ADD CONSTRAINT ck_employee_classification CHECK (classification IN ('fullTime','contractor'));
      ALTER TABLE employee_identity
        ADD COLUMN gender text,
        ADD COLUMN phone text COLLATE "C",
        ADD COLUMN work_email text COLLATE "C",
        ADD CONSTRAINT ck_employee_identity_gender CHECK (gender IN ('male','female','other')),
        ADD CONSTRAINT ck_employee_identity_phone CHECK (phone ~ '^0[1-9][0-9]{8,9}$'),
        ADD CONSTRAINT ck_employee_identity_work_email CHECK (
          char_length(work_email) <= 254
          AND work_email ~ '^[a-z0-9_+-]+([.][a-z0-9_+-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}$');
      GRANT INSERT(job_position,classification) ON employee TO product_data;
      GRANT UPDATE(job_position,classification) ON employee TO product_data;
      GRANT UPDATE(gender,phone,work_email) ON employee_identity TO product_data;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

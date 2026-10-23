import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Body of `public.hr_register_object` from T3 on: adds the F2/F3 record types. The type list stays
 * fixed in the body (ADR 0016 §4); `hrCompany` is not registrable here, its single anchor is
 * created by the sync login (permission/permission-object.repository.ts#ensureCompany).
 */
export const hrRegisterObjectBodyT3 = `
DECLARE
  v_object uuid := gen_random_uuid();
BEGIN
  IF p_type IS NULL OR p_key IS NULL OR p_type NOT IN ('employee','team','workRequest','employeeIdentity','leaveRate') THEN
    RAISE EXCEPTION 'object type is not registrable' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.object_ref(object_id,type_key,key_kind,key_bytes)
    VALUES (v_object, convert_to(p_type,'UTF8'), 'uuid', convert_to(p_key::text,'UTF8'));
  RETURN v_object;
END`;

/** `self` scope of the F2/F3 resources, read from the current account link (design §5.3). */
export const hrOwnerViews: Readonly<Record<string, string>> = {
  hr_employee_owner: `SELECT e.id AS employee_id, e.account_id FROM public.employee e WHERE e.account_id IS NOT NULL`,
  hr_leave_rate_owner: `SELECT r.id AS rate_id, e.account_id FROM public.leave_rate r JOIN public.employee e ON e.id = r.employee_id WHERE e.account_id IS NOT NULL`,
};

/**
 * T3 employee profile (ADR 0018): business dates, F2 identity, employment status periods, F3
 * leave rates and the company anchor. Status periods are a gapless chain written only by the
 * employee commands under the employee row lock, so no EXCLUDE constraint (no btree_gist).
 * Adding NOT NULL `hired_on` fails on a table with rows: existing records need a reviewed mapping.
 * Replaces a function owned by `product_object_owner`, so it runs through `db:provision`.
 */
export class HrmEmployee1792108800101 implements MigrationInterface {
  name = 'HrmEmployee1792108800101';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      ALTER TABLE employee
        ADD COLUMN hired_on date NOT NULL,
        ADD COLUMN terminated_on date,
        ADD CONSTRAINT ck_employee_dates CHECK (hired_on >= DATE '1950-01-01' AND (terminated_on IS NULL OR terminated_on >= hired_on));
      CREATE TABLE employee_identity(
        employee_id uuid PRIMARY KEY REFERENCES employee(id),
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        date_of_birth date CHECK (date_of_birth >= DATE '1900-01-01'),
        document_kind text CHECK (document_kind IN ('cccd','cmnd','passport')),
        document_number text COLLATE "C" CHECK (document_number ~ '^[A-Z0-9]{6,20}$'),
        tax_code text COLLATE "C" CHECK (tax_code ~ '^[0-9]{10,13}(-[0-9]{3})?$'),
        version int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
        CONSTRAINT ck_employee_identity_document CHECK ((document_kind IS NULL) = (document_number IS NULL)),
        CONSTRAINT uq_employee_identity_document UNIQUE (document_kind, document_number)
      );
      CREATE TABLE employment_status_period(
        id uuid PRIMARY KEY,
        employee_id uuid NOT NULL REFERENCES employee(id),
        status text NOT NULL CHECK (status IN ('probation','official')),
        starts_on date NOT NULL,
        ends_on date,
        CHECK (ends_on IS NULL OR ends_on > starts_on),
        CONSTRAINT uq_employment_status_start UNIQUE (employee_id, starts_on)
      );
      CREATE UNIQUE INDEX uq_employment_status_open ON employment_status_period(employee_id) WHERE ends_on IS NULL;
      CREATE TABLE leave_rate(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        employee_id uuid NOT NULL REFERENCES employee(id),
        effective_from date NOT NULL,
        annual_minutes integer NOT NULL CHECK (annual_minutes BETWEEN 5760 AND 175680),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT uq_leave_rate_effective UNIQUE (employee_id, effective_from)
      );
      CREATE TABLE hr_company(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        singleton boolean NOT NULL DEFAULT true CHECK (singleton),
        version int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
        CONSTRAINT uq_hr_company_singleton UNIQUE (singleton)
      );
    `);
    for (const [name, definition] of Object.entries(hrOwnerViews))
      await r.query(`CREATE VIEW ${name} WITH (security_invoker=true) AS ${definition}`);
    // Only the owner may replace the function; owner, ACL and SECURITY DEFINER stay as they were.
    // The NOINHERIT migration login acts as the owner for this one statement (provision membership).
    await r.query(`
      SET LOCAL ROLE product_object_owner;
      CREATE OR REPLACE FUNCTION public.hr_register_object(p_type text, p_key uuid) RETURNS uuid
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${hrRegisterObjectBodyT3}$fn$;
      RESET ROLE;
    `);
    await r.query(`
      -- The data login creates F1/F2/F3 rows but never sets the account link (facts, ADR 0016 §5).
      GRANT SELECT ON employee_identity,employment_status_period,leave_rate,hr_company,hr_employee_owner,hr_leave_rate_owner TO product_data;
      GRANT INSERT(id,object_id,code,full_name,hired_on) ON employee TO product_data;
      GRANT UPDATE(code,full_name,terminated_on) ON employee TO product_data;
      GRANT INSERT ON employee_identity,employment_status_period,leave_rate TO product_data;
      GRANT UPDATE(date_of_birth,document_kind,document_number,tax_code,version) ON employee_identity TO product_data;
      GRANT UPDATE(ends_on) ON employment_status_period TO product_data;
      -- Row locks of company-level creates (ADR 0017 needs UPDATE on one column to lock).
      GRANT UPDATE(version) ON hr_company TO product_data;
      GRANT UPDATE(version) ON employee TO product_authority;
      GRANT SELECT ON hr_company TO product_sync;
      GRANT INSERT ON hr_company TO product_sync;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

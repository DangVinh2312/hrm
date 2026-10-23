import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Body of `public.hr_register_object` (ADR 0016 §4). The type list is fixed here, not read from a
 * table: the data login can register HR records only, never authority or other application types.
 */
export const registerObjectBody = `
DECLARE
  v_object uuid := gen_random_uuid();
BEGIN
  IF p_type IS NULL OR p_key IS NULL OR p_type NOT IN ('employee','team','workRequest') THEN
    RAISE EXCEPTION 'object type is not registrable' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.object_ref(object_id,type_key,key_kind,key_bytes)
    VALUES (v_object, convert_to(p_type,'UTF8'), 'uuid', convert_to(p_key::text,'UTF8'));
  RETURN v_object;
END`;

/** Current row of a validity window, on the statement clock (same rule as the compiler). */
const current = (alias: string) =>
  `${alias}.starts_at <= statement_timestamp() AND (${alias}.ends_at IS NULL OR ${alias}.ends_at > statement_timestamp())`;

/**
 * Views behind the HR domain relations (design §5.3). Accounts come from the current
 * employee.account_id link, never copied, so a re-link moves scope in the next transaction.
 */
export const authorizationScopeViews: Readonly<Record<string, string>> = {
  hr_team_member: `SELECT m.team_id, e.account_id FROM public.team_membership m JOIN public.employee e ON e.id = m.employee_id WHERE e.account_id IS NOT NULL AND ${current('m')}`,
  hr_team_lead: `SELECT l.team_id, e.account_id AS lead_account_id FROM public.team_lead_assignment l JOIN public.employee e ON e.id = l.lead_employee_id WHERE e.account_id IS NOT NULL AND ${current('l')}`,
  hr_employee_lead: `SELECT m.employee_id, e.account_id AS lead_account_id FROM public.team_membership m JOIN public.team_lead_assignment l ON l.team_id = m.team_id JOIN public.employee e ON e.id = l.lead_employee_id WHERE e.account_id IS NOT NULL AND ${current('m')} AND ${current('l')}`,
  hr_request_owner: `SELECT r.id AS request_id, e.account_id FROM public.work_request r JOIN public.employee e ON e.id = r.employee_id WHERE e.account_id IS NOT NULL`,
  // First-step approver now (§6.4): lead of the request's team while the employee is still a
  // member there, otherwise lead of the employee's current primary team.
  hr_request_lead: `SELECT r.id AS request_id, e.account_id AS lead_account_id FROM public.work_request r JOIN public.team_membership m ON m.employee_id = r.employee_id AND ${current('m')} AND (m.team_id = r.team_id OR (m.is_primary AND NOT EXISTS (SELECT 1 FROM public.team_membership c WHERE c.employee_id = r.employee_id AND c.team_id = r.team_id AND ${current('c')}))) JOIN public.team_lead_assignment l ON l.team_id = m.team_id AND ${current('l')} JOIN public.employee e ON e.id = l.lead_employee_id WHERE e.account_id IS NOT NULL`,
  hr_request_decider: `SELECT d.request_id, d.actor_account_id FROM public.request_decision d WHERE d.actor_kind = 'user'`,
};

/**
 * HR authorization skeleton (T2, ADR 0016/0018): only key, owner and fact columns that scopes and
 * commands need. Business columns, F2/F3, segments and idempotency arrive with T3/T5/T6 as forward
 * migrations. Needs the NOLOGIN `product_object_owner`, so it runs through `db:provision`.
 */
export class HrmAuthorization1792108800100 implements MigrationInterface {
  name = 'HrmAuthorization1792108800100';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`
      CREATE TABLE employee(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        code text COLLATE "C" NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 1 AND 32),
        full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
        account_id uuid UNIQUE REFERENCES app_user(id),
        version int8 NOT NULL DEFAULT 1 CHECK (version >= 1)
      );
      CREATE TABLE team(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200)
      );
      CREATE TABLE team_membership(
        id uuid PRIMARY KEY,
        employee_id uuid NOT NULL REFERENCES employee(id),
        team_id uuid NOT NULL REFERENCES team(id),
        is_primary boolean NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz,
        CHECK (ends_at IS NULL OR ends_at > starts_at)
      );
      CREATE UNIQUE INDEX uq_team_membership_open ON team_membership(employee_id, team_id) WHERE ends_at IS NULL;
      CREATE UNIQUE INDEX uq_team_membership_primary ON team_membership(employee_id) WHERE ends_at IS NULL AND is_primary;
      CREATE INDEX ix_team_membership_team ON team_membership(team_id, employee_id);
      CREATE TABLE team_lead_assignment(
        id uuid PRIMARY KEY,
        team_id uuid NOT NULL REFERENCES team(id),
        lead_employee_id uuid NOT NULL REFERENCES employee(id),
        starts_at timestamptz NOT NULL,
        ends_at timestamptz,
        CHECK (ends_at IS NULL OR ends_at > starts_at)
      );
      CREATE UNIQUE INDEX uq_team_lead_open ON team_lead_assignment(team_id) WHERE ends_at IS NULL;
      CREATE INDEX ix_team_lead_employee ON team_lead_assignment(lead_employee_id);
      CREATE TABLE work_request(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        employee_id uuid NOT NULL REFERENCES employee(id),
        owner_account_id uuid NOT NULL REFERENCES app_user(id),
        team_id uuid NOT NULL REFERENCES team(id),
        kind text NOT NULL CHECK (kind IN ('late-arrival','early-departure','wfh','annual-leave','unpaid-leave')),
        state text NOT NULL CHECK (state IN ('pending_lead','pending_final','approved','rejected','cancelled')),
        version int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp()
      );
      CREATE INDEX ix_work_request_employee ON work_request(employee_id, id);
      CREATE INDEX ix_work_request_team ON work_request(team_id, id);
      CREATE INDEX ix_work_request_state ON work_request(state, id);
      CREATE TABLE request_decision(
        id uuid PRIMARY KEY,
        request_id uuid NOT NULL REFERENCES work_request(id),
        stage text NOT NULL CHECK (stage IN ('lead','final','cancel')),
        decision text NOT NULL CHECK (decision IN ('approve','reject','skip','cancel')),
        actor_kind text NOT NULL CHECK (actor_kind IN ('user','system')),
        actor_account_id uuid REFERENCES app_user(id),
        system_reason text CHECK (system_reason IN ('lead_skipped_submitter_is_lead','coo_self_approved')),
        decided_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT uq_request_decision_stage UNIQUE (request_id, stage),
        CONSTRAINT ck_request_decision_actor CHECK ((actor_kind = 'user') = (actor_account_id IS NOT NULL)),
        CONSTRAINT ck_request_decision_system CHECK ((actor_kind = 'system') = (system_reason IS NOT NULL))
      );
      CREATE INDEX ix_request_decision_actor ON request_decision(actor_account_id, request_id);
    `);
    for (const [name, definition] of Object.entries(authorizationScopeViews))
      await r.query(`CREATE VIEW ${name} WITH (security_invoker=true) AS ${definition}`);
    const views = Object.keys(authorizationScopeViews).join(',');
    // Decisions are append-only for the runtime: INSERT/SELECT, no UPDATE/DELETE (design §6.3).
    await r.query(`
      GRANT SELECT ON employee,team,team_membership,team_lead_assignment,work_request,request_decision,${views} TO product_data;
      GRANT INSERT ON work_request,request_decision TO product_data;
      GRANT UPDATE(state,version) ON work_request TO product_data;
      -- Row locks need UPDATE on one column: employee.version lets commands lock the employee
      -- (ADR 0017 step 4) without any other writable employee column.
      GRANT UPDATE(version) ON employee TO product_data;
      GRANT SELECT ON employee,team,team_membership,team_lead_assignment TO product_authority;
      GRANT INSERT ON team_membership,team_lead_assignment TO product_authority;
      GRANT UPDATE(ends_at) ON team_membership,team_lead_assignment TO product_authority;
      GRANT UPDATE(account_id) ON employee TO product_authority;
      CREATE FUNCTION public.hr_register_object(p_type text, p_key uuid) RETURNS uuid
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${registerObjectBody}$fn$;
      REVOKE ALL ON FUNCTION public.hr_register_object(text,uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.hr_register_object(text,uuid) TO product_data;
      GRANT INSERT ON object_ref TO product_object_owner;
      ALTER FUNCTION public.hr_register_object(text,uuid) OWNER TO product_object_owner;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

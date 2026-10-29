import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Application baseline (ADR 0048): the Document fixture and the HR schema in their final shape,
 * replacing `ProductDocument` and the forward migrations `HrmAuthorization` ... `HrmRole`
 * (100-114). It runs after the product baseline, on an empty database, and through `db:provision`
 * because it hands `hr_register_object` to the NOLOGIN `product_object_owner`. From this baseline
 * on, an applied migration is not edited; schema changes are new forward migrations.
 */

/** Minimal resource fixture owned by the application; the product baseline contains no domain. */
export const documentFixtureSql = `CREATE TABLE document(id uuid PRIMARY KEY,object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),owner_id uuid NOT NULL REFERENCES app_user(id),title text NOT NULL CHECK(octet_length(title) BETWEEN 1 AND 500),state text NOT NULL CHECK(state IN('draft','published'))); CREATE INDEX ix_document_owner ON document(owner_id,id); GRANT SELECT,UPDATE(title) ON document TO product_data; GRANT SELECT ON document TO product_authority;`;

/**
 * Body of `public.hr_register_object` from T3 on: adds the F2/F3 record types. The type list stays
 * fixed in the body (ADR 0016 §4); `hrCompany` is not registrable here, its single anchor is
 * created by the sync login (permission/permission-object.repository.ts#ensureCompany).
 */
export const registerObjectBody = `
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

/** `self` scope of the F2/F3 resources, read from the current account link (design §5.3). */
export const employeeOwnerViews: Readonly<Record<string, string>> = {
  hr_employee_owner: `SELECT e.id AS employee_id, e.account_id FROM public.employee e WHERE e.account_id IS NOT NULL`,
  hr_leave_rate_owner: `SELECT r.id AS rate_id, e.account_id FROM public.leave_rate r JOIN public.employee e ON e.id = r.employee_id WHERE e.account_id IS NOT NULL`,
};

/**
 * Release 9 scope view (ADR 0016 Release 9): a request rejected at the lead step whose owner is,
 * right now, the lead of a team. The COO reads exactly these in addition to the final queue and
 * what they decided: `workRequest.leadRejectedLeadOwned` has no identity column worth matching
 * (the target is the owner's account), so the template only asks that a row exists. Facts read at
 * statement time like every HR view; reading only, no decision follows from it.
 */
export const requestLeadViews: Readonly<Record<string, string>> = {
  hr_request_lead_rejected: `SELECT r.id AS request_id, r.owner_account_id FROM public.work_request r WHERE r.state = 'rejected' AND EXISTS (SELECT 1 FROM public.request_decision d WHERE d.request_id = r.id AND d.stage = 'lead' AND d.decision = 'reject' AND d.actor_kind = 'user') AND EXISTS (SELECT 1 FROM public.team_lead_assignment l WHERE l.lead_employee_id = r.employee_id AND l.starts_at <= statement_timestamp() AND (l.ends_at IS NULL OR l.ends_at > statement_timestamp()))`,
};

export class ApplicationBaseline1792108800002 implements MigrationInterface {
  name = 'ApplicationBaseline1792108800002';

  async up(r: QueryRunner): Promise<void> {
    await r.query(documentFixtureSql);
    await r.query(`
      CREATE TABLE employee(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        code text COLLATE "C" NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 1 AND 32),
        full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
        account_id uuid UNIQUE REFERENCES app_user(id),
        version int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
        hired_on date NOT NULL,
        terminated_on date,
        job_position text COLLATE "C",
        classification text,
        CONSTRAINT ck_employee_dates CHECK (hired_on >= DATE '1950-01-01' AND (terminated_on IS NULL OR terminated_on >= hired_on)),
        CONSTRAINT ck_employee_job_position CHECK (
          job_position IS NULL
          OR (char_length(job_position) BETWEEN 1 AND 100
              AND job_position = btrim(job_position)
              AND job_position !~ '[[:cntrl:]]')),
        CONSTRAINT ck_employee_classification CHECK (classification IN ('fullTime','contractor'))
      );
      CREATE TABLE team(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
        version int8 NOT NULL DEFAULT 1 CONSTRAINT ck_team_version CHECK (version >= 1)
      );
      CREATE UNIQUE INDEX uq_team_name ON team (lower(name));
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
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        reason text NOT NULL CONSTRAINT ck_work_request_reason CHECK (char_length(reason) BETWEEN 1 AND 1000),
        CONSTRAINT uq_work_request_kind UNIQUE (id, kind)
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
        reason text CONSTRAINT ck_request_decision_reason CHECK (char_length(reason) BETWEEN 1 AND 1000),
        CONSTRAINT uq_request_decision_stage UNIQUE (request_id, stage),
        CONSTRAINT ck_request_decision_actor CHECK ((actor_kind = 'user') = (actor_account_id IS NOT NULL)),
        CONSTRAINT ck_request_decision_system CHECK ((actor_kind = 'system') = (system_reason IS NOT NULL)),
        CONSTRAINT ck_request_decision_reject_reason CHECK (decision <> 'reject' OR reason IS NOT NULL)
      );
      CREATE INDEX ix_request_decision_actor ON request_decision(actor_account_id, request_id);
      CREATE TABLE employee_identity(
        employee_id uuid PRIMARY KEY REFERENCES employee(id),
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        date_of_birth date CHECK (date_of_birth >= DATE '1900-01-01'),
        document_kind text CHECK (document_kind IN ('cccd','cmnd','passport')),
        document_number text COLLATE "C" CHECK (document_number ~ '^[A-Z0-9]{6,20}$'),
        tax_code text COLLATE "C" CHECK (tax_code ~ '^[0-9]{10,13}(-[0-9]{3})?$'),
        version int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
        gender text,
        phone text COLLATE "C",
        work_email text COLLATE "C",
        CONSTRAINT ck_employee_identity_document CHECK ((document_kind IS NULL) = (document_number IS NULL)),
        CONSTRAINT uq_employee_identity_document UNIQUE (document_kind, document_number),
        CONSTRAINT ck_employee_identity_gender CHECK (gender IN ('male','female','other')),
        CONSTRAINT ck_employee_identity_phone CHECK (phone ~ '^0[1-9][0-9]{8,9}$'),
        CONSTRAINT ck_employee_identity_work_email CHECK (
          char_length(work_email) <= 254
          AND work_email ~ '^[a-z0-9_+-]+([.][a-z0-9_+-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}$')
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
      CREATE TABLE work_calendar(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        singleton boolean NOT NULL DEFAULT true CHECK (singleton),
        version int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
        CONSTRAINT uq_work_calendar_singleton UNIQUE (singleton)
      );
      CREATE TABLE work_calendar_change(
        version int8 PRIMARY KEY CHECK (version >= 2),
        day date NOT NULL CONSTRAINT ck_work_calendar_change_day CHECK (day BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
        kind text NOT NULL,
        name text CHECK (char_length(name) BETWEEN 1 AND 200),
        changed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT ck_work_calendar_change_name CHECK ((kind = 'paid_holiday') = (name IS NOT NULL)),
        CONSTRAINT ck_work_calendar_change_kind CHECK (
          kind = 'standard'
          OR (kind = 'paid_holiday' AND extract(isodow FROM day) < 6)
          OR (kind = 'makeup_workday' AND extract(isodow FROM day) >= 6))
      );
      CREATE INDEX ix_work_calendar_change_day ON work_calendar_change(day, version);
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
        ),
        CONSTRAINT uq_work_request_segment_kind UNIQUE (request_id, work_date, kind)
      );
      CREATE INDEX ix_work_request_segment_date ON work_request_segment(work_date, request_id);
      CREATE TABLE hr_idempotency(
        actor_id uuid NOT NULL REFERENCES app_user(id),
        operation text NOT NULL CONSTRAINT ck_hr_idempotency_operation CHECK (operation IN
          ('workRequest.submit','workRequest.decide','workRequest.cancel','leave.adjust','attendance.adjust')),
        key uuid NOT NULL,
        payload_hash text COLLATE "C" NOT NULL CONSTRAINT ck_hr_idempotency_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        target_id uuid NOT NULL,
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT pk_hr_idempotency PRIMARY KEY (actor_id, operation, key)
      );
      CREATE TABLE leave_bucket(
        employee_id uuid NOT NULL REFERENCES employee(id),
        year smallint NOT NULL CONSTRAINT ck_leave_bucket_year CHECK (year BETWEEN 1900 AND 2100),
        revision int8 NOT NULL DEFAULT 1 CONSTRAINT ck_leave_bucket_revision CHECK (revision >= 1),
        CONSTRAINT pk_leave_bucket PRIMARY KEY (employee_id, year)
      );
      CREATE TABLE leave_ledger(
        id uuid PRIMARY KEY,
        employee_id uuid NOT NULL REFERENCES employee(id),
        entry_kind text NOT NULL CONSTRAINT ck_leave_ledger_kind CHECK (entry_kind IN ('debit','reversal','opening','adjustment')),
        effective_on date NOT NULL CONSTRAINT ck_leave_ledger_date CHECK (effective_on BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
        minutes integer NOT NULL,
        source_request_id uuid,
        source_work_date date,
        source_kind text GENERATED ALWAYS AS (CASE WHEN source_request_id IS NOT NULL THEN 'annual-leave' END) STORED,
        reverses_entry_id uuid,
        reference text COLLATE "C" CONSTRAINT ck_leave_ledger_reference CHECK (char_length(reference) BETWEEN 1 AND 200),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT ck_leave_ledger_shape CHECK (
          (entry_kind = 'debit' AND minutes BETWEEN 1 AND 480 AND source_request_id IS NOT NULL
             AND source_work_date = effective_on AND reverses_entry_id IS NULL AND reference IS NULL)
          OR (entry_kind = 'reversal' AND minutes BETWEEN 1 AND 480 AND reverses_entry_id IS NOT NULL
             AND source_request_id IS NULL AND source_work_date IS NULL AND reference IS NULL)
          OR (entry_kind IN ('opening','adjustment') AND minutes <> 0 AND minutes BETWEEN -175680 AND 175680
             AND reference IS NOT NULL AND source_request_id IS NULL AND source_work_date IS NULL
             AND reverses_entry_id IS NULL)),
        CONSTRAINT uq_leave_ledger_segment UNIQUE (source_request_id, source_work_date),
        CONSTRAINT uq_leave_ledger_reverses UNIQUE (reverses_entry_id),
        CONSTRAINT uq_leave_ledger_entry UNIQUE (id, employee_id, effective_on, minutes),
        CONSTRAINT fk_leave_ledger_segment FOREIGN KEY (source_request_id, source_work_date, source_kind)
          REFERENCES work_request_segment(request_id, work_date, kind),
        CONSTRAINT fk_leave_ledger_reverses FOREIGN KEY (reverses_entry_id, employee_id, effective_on, minutes)
          REFERENCES leave_ledger(id, employee_id, effective_on, minutes)
      );
      CREATE INDEX ix_leave_ledger_employee ON leave_ledger(employee_id, effective_on);
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
      CREATE TABLE attendance_adjustment(
        id uuid PRIMARY KEY,
        employee_id uuid NOT NULL REFERENCES employee(id),
        work_date date NOT NULL CONSTRAINT ck_attendance_adjustment_date CHECK (
          work_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
        minutes integer NOT NULL CONSTRAINT ck_attendance_adjustment_minutes CHECK (
          minutes <> 0 AND minutes BETWEEN -1440 AND 1440),
        reason text COLLATE "C" NOT NULL CONSTRAINT ck_attendance_adjustment_reason CHECK (
          char_length(reason) BETWEEN 1 AND 300 AND reason !~ '[[:cntrl:]]'),
        reference text COLLATE "C" CONSTRAINT ck_attendance_adjustment_reference CHECK (
          reference IS NULL OR (char_length(reference) BETWEEN 1 AND 64 AND reference !~ '[[:cntrl:]]')),
        actor_account_id uuid NOT NULL REFERENCES app_user(id),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp()
      );
      CREATE INDEX ix_attendance_adjustment_employee ON attendance_adjustment(employee_id, work_date);
      CREATE TABLE setting_anchor(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        singleton boolean NOT NULL DEFAULT true CHECK (singleton),
        version int8 NOT NULL DEFAULT 1 CHECK (version >= 1),
        CONSTRAINT uq_setting_anchor_singleton UNIQUE (singleton)
      );
      CREATE TABLE system_setting(
        key text COLLATE "C" PRIMARY KEY CONSTRAINT ck_system_setting_key CHECK (
          char_length(key) BETWEEN 3 AND 64 AND key ~ '^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)+$'),
        value jsonb NOT NULL CONSTRAINT ck_system_setting_value CHECK (
          jsonb_typeof(value) IN ('number','string')),
        version int8 NOT NULL CONSTRAINT ck_system_setting_version CHECK (version >= 1),
        updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        updated_by uuid NOT NULL REFERENCES app_user(id)
      );
      CREATE TABLE system_setting_history(
        key text COLLATE "C" NOT NULL REFERENCES system_setting(key),
        version int8 NOT NULL CONSTRAINT ck_system_setting_history_version CHECK (version >= 1),
        old_value jsonb NOT NULL CONSTRAINT ck_system_setting_history_old CHECK (
          jsonb_typeof(old_value) IN ('number','string')),
        new_value jsonb NOT NULL CONSTRAINT ck_system_setting_history_new CHECK (
          jsonb_typeof(new_value) IN ('number','string')),
        changed_by uuid NOT NULL REFERENCES app_user(id),
        changed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        PRIMARY KEY (key, version)
      );
      CREATE TABLE role_anchor(
        id uuid PRIMARY KEY,
        object_id uuid NOT NULL UNIQUE REFERENCES object_ref(object_id),
        singleton boolean NOT NULL DEFAULT true CHECK (singleton),
        CONSTRAINT uq_role_anchor_singleton UNIQUE (singleton)
      );
    `);
    for (const [name, definition] of Object.entries({
      ...authorizationScopeViews,
      ...employeeOwnerViews,
      ...requestLeadViews,
    }))
      await r.query(`CREATE VIEW ${name} WITH (security_invoker=true) AS ${definition}`);
    const views = Object.keys({
      ...authorizationScopeViews,
      ...employeeOwnerViews,
      ...requestLeadViews,
    }).join(',');
    await r.query(`
      -- The runtime has no UPDATE/DELETE on decisions, ledgers and histories (append-only).
      GRANT SELECT ON employee,team,team_membership,team_lead_assignment,work_request,request_decision,${views} TO product_data;
      GRANT INSERT ON work_request,request_decision TO product_data;
      GRANT UPDATE(state,version) ON work_request TO product_data;
      -- Row locks need UPDATE on one column: version (ADR 0017 step 4), no other writable column.
      GRANT UPDATE(version) ON employee,hr_company,team,work_calendar,setting_anchor TO product_data;
      GRANT UPDATE(version) ON employee,team TO product_authority;
      GRANT SELECT ON employee,team,team_membership,team_lead_assignment TO product_authority;
      GRANT INSERT ON team_membership,team_lead_assignment TO product_authority;
      GRANT UPDATE(ends_at) ON team_membership,team_lead_assignment TO product_authority;
      GRANT UPDATE(account_id) ON employee TO product_authority;
      -- The data login creates employee/team rows but never sets the account link (facts, ADR 0016 §5).
      GRANT INSERT(id,object_id,code,full_name,hired_on,job_position,classification) ON employee TO product_data;
      GRANT UPDATE(code,full_name,terminated_on,job_position,classification) ON employee TO product_data;
      GRANT INSERT(id,object_id,name) ON team TO product_data;
      GRANT UPDATE(name,version) ON team TO product_data;
      GRANT SELECT ON employee_identity,employment_status_period,leave_rate,hr_company,work_calendar,work_calendar_change,setting_anchor,role_anchor,system_setting,system_setting_history TO product_data;
      GRANT INSERT ON employee_identity,employment_status_period,leave_rate,work_calendar_change,system_setting,system_setting_history TO product_data;
      GRANT UPDATE(date_of_birth,document_kind,document_number,tax_code,version,gender,phone,work_email) ON employee_identity TO product_data;
      GRANT UPDATE(ends_on) ON employment_status_period TO product_data;
      GRANT UPDATE(value,version,updated_at,updated_by) ON system_setting TO product_data;
      GRANT SELECT,INSERT ON work_request_segment,hr_idempotency,leave_bucket,leave_ledger,wfh_month_counter,attendance_period,attendance_period_event,attendance_adjustment TO product_data;
      GRANT UPDATE(revision) ON leave_bucket TO product_data;
      GRANT UPDATE(approved_count,revision) ON wfh_month_counter TO product_data;
      GRANT UPDATE(state,version,snapshot,snapshot_hash) ON attendance_period TO product_data;
      -- Anchors are created by the sync login after the release that declares the resource.
      GRANT SELECT,INSERT ON hr_company,work_calendar,setting_anchor,role_anchor TO product_sync;
      -- Append-only history: a trigger stops UPDATE, DELETE and TRUNCATE for every login, the owner included.
      CREATE FUNCTION public.forbid_setting_history_change() RETURNS trigger
        LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
      BEGIN
        RAISE EXCEPTION 'system_setting_history is append-only' USING ERRCODE = '42501';
      END $fn$;
      REVOKE ALL ON FUNCTION public.forbid_setting_history_change() FROM PUBLIC;
      CREATE TRIGGER forbid_setting_history_row_change
        BEFORE UPDATE OR DELETE ON system_setting_history
        FOR EACH ROW EXECUTE FUNCTION public.forbid_setting_history_change();
      CREATE TRIGGER forbid_setting_history_truncate
        BEFORE TRUNCATE ON system_setting_history
        FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_setting_history_change();
      -- The data login registers HR records only (ADR 0016 §4); the type list is fixed in the body.
      CREATE FUNCTION public.hr_register_object(p_type text, p_key uuid) RETURNS uuid
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${registerObjectBody}$fn$;
      REVOKE ALL ON FUNCTION public.hr_register_object(text,uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.hr_register_object(text,uuid) TO product_data;
      GRANT INSERT ON object_ref TO product_object_owner;
      ALTER FUNCTION public.hr_register_object(text,uuid) OWNER TO product_object_owner;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Application baseline requires an explicit restore; automatic downgrade is disabled',
      ),
    );
  }
}

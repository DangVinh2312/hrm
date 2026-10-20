import { type DataSource, QueryFailedError } from 'typeorm';
import type { ProductTransaction } from '../database/product-transaction.runner.js';
import type { ProductScope } from '../authorization/services/product-authority.service.js';
import { functionOwnerGrants } from '../database/helpers/product-database.helper.js';
import { hrScopeViews } from './migrations/hrm-authorization.migration.js';
import {
  hrOwnerViews,
  hrRegisterObjectBodyT3,
} from '../employee/migrations/hrm-employee.migration.js';

const hrTables = [
  'employee',
  'team',
  'team_membership',
  'team_lead_assignment',
  'work_request',
  'request_decision',
  'employee_identity',
  'employment_status_period',
  'leave_rate',
  'hr_company',
  'work_calendar',
  'work_calendar_change',
  'work_request_segment',
  'hr_idempotency',
];
const hrViews = { ...hrScopeViews, ...hrOwnerViews };
const registerObject = 'function:hr_register_object(text, uuid):EXECUTE';

const columns = (privilege: string, table: string, names: readonly string[]) =>
  names.map((name) => `column:${table}.${name}:${privilege}`);

/**
 * Exact grants the HR migrations (T2, T3 employee/team, T4 work calendar, T5 requests) add to each login; part of the startup
 * privilege probe. The data login never writes `employee.account_id` or membership/lead rows.
 */
export const hrPrivileges = {
  data: [
    ...[...hrTables, ...Object.keys(hrViews)].map((t) => `table:${t}:SELECT`),
    'table:work_request:INSERT',
    'table:request_decision:INSERT',
    'table:employee_identity:INSERT',
    'table:employment_status_period:INSERT',
    'table:leave_rate:INSERT',
    'column:work_request.state:UPDATE',
    'column:work_request.version:UPDATE',
    ...columns('INSERT', 'employee', [
      'id',
      'object_id',
      'code',
      'full_name',
      'hired_on',
      'job_position',
      'classification',
    ]),
    ...columns('UPDATE', 'employee', [
      'version',
      'code',
      'full_name',
      'terminated_on',
      'job_position',
      'classification',
    ]),
    ...columns('UPDATE', 'employee_identity', [
      'date_of_birth',
      'document_kind',
      'document_number',
      'tax_code',
      'version',
      'gender',
      'phone',
      'work_email',
    ]),
    'column:employment_status_period.ends_on:UPDATE',
    'column:hr_company.version:UPDATE',
    ...columns('INSERT', 'team', ['id', 'object_id', 'name']),
    ...columns('UPDATE', 'team', ['name', 'version']),
    // T4: append-only calendar history; the singleton row only bumps its version.
    'table:work_calendar_change:INSERT',
    'column:work_calendar.version:UPDATE',
    // T5: segments and idempotency claims are append-only for the runtime.
    'table:work_request_segment:INSERT',
    'table:hr_idempotency:INSERT',
    registerObject,
  ],
  authority: [
    ...['employee', 'team', 'team_membership', 'team_lead_assignment'].map(
      (t) => `table:${t}:SELECT`,
    ),
    'table:team_membership:INSERT',
    'table:team_lead_assignment:INSERT',
    'column:team_membership.ends_at:UPDATE',
    'column:team_lead_assignment.ends_at:UPDATE',
    'column:employee.account_id:UPDATE',
    'column:employee.version:UPDATE',
    'column:team.version:UPDATE',
  ],
  sync: [
    'table:hr_company:SELECT',
    'table:hr_company:INSERT',
    'table:work_calendar:SELECT',
    'table:work_calendar:INSERT',
  ],
} as const;

/**
 * Business date today (ADR 0018): the DB statement clock in the fixed business timezone, never
 * the API host's clock or zone. SQL fragment without parameters.
 */
export const HR_TODAY = "(statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";

/** Current row of a validity window on the statement clock (same rule as the scope views). */
export const hrCurrent = (alias: string) =>
  `${alias}.starts_at <= statement_timestamp() AND (${alias}.ends_at IS NULL OR ${alias}.ends_at > statement_timestamp())`;

/** Parameters after the plan's own, with the placeholder of the i-th (1-based) added value. */
export function hrScoped(scope: ProductScope, ...values: readonly unknown[]) {
  const base = scope.parameters.length;
  return {
    parameters: [...scope.parameters, ...values],
    at: (index: number) => `$${base + index}`,
  };
}

/** A UNIQUE constraint refused the write (duplicate code, document, link…). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError && (error.driverError as { code?: unknown }).code === '23505'
  );
}

/** Key of the single `hrCompany` record, parent of company-level creates (design §7.2). */
export const HR_COMPANY_ID = '00000000-0000-4000-8000-000000000c01';

/** Key of the single `workCalendar` record (T4): permissions and the current version. */
export const WORK_CALENDAR_ID = '00000000-0000-4000-8000-000000000c02';

/**
 * Creates a code-owned singleton anchor once, after the release that declares its resource is
 * applied (its object_ref needs the resource type). Idempotent DML of a constant, run by the sync
 * login next to the manifest; readiness only checks that it exists. Identifiers are fixed here.
 */
async function ensureAnchor(
  tx: ProductTransaction,
  anchor: {
    readonly type: 'hrCompany' | 'workCalendar';
    readonly table: string;
    readonly id: string;
  },
): Promise<void> {
  await tx.manager.query(
    `WITH registered AS (
       INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes)
         VALUES (gen_random_uuid(), convert_to($2,'UTF8'), 'uuid', convert_to(CAST($1 AS text),'UTF8'))
         ON CONFLICT (type_key,key_kind,key_bytes) DO NOTHING RETURNING object_id)
     INSERT INTO ${anchor.table}(id,object_id) SELECT CAST(CAST($1 AS text) AS uuid), object_id FROM registered
       ON CONFLICT DO NOTHING`,
    [anchor.id, anchor.type],
  );
  const [row] = await tx.manager.query<{ ok: boolean }[]>(
    `SELECT EXISTS(SELECT 1 FROM ${anchor.table} c JOIN object_ref o ON o.object_id=c.object_id
       WHERE c.id=CAST(CAST($1 AS text) AS uuid) AND o.type_key=convert_to($2,'UTF8')
         AND o.key_bytes=convert_to(CAST($1 AS text),'UTF8')) AS ok`,
    [anchor.id, anchor.type],
  );
  if (!row?.ok) throw new Error(`${anchor.type} anchor is inconsistent`);
}

/** The company anchor, parent of company-level creates (design §7.2). */
export function ensureHrCompany(tx: ProductTransaction): Promise<void> {
  return ensureAnchor(tx, { type: 'hrCompany', table: 'hr_company', id: HR_COMPANY_ID });
}

/** The work calendar anchor at version 1 (standard week, no holiday) on first creation. */
export function ensureWorkCalendar(tx: ProductTransaction): Promise<void> {
  return ensureAnchor(tx, { type: 'workCalendar', table: 'work_calendar', id: WORK_CALENDAR_ID });
}

/**
 * Fails readiness when no validated CHECK named `ck_work_calendar_change_kind` exists, i.e. when
 * migration 104 was not applied. It proves the name only, not the constraint body. Parameterized,
 * read-only catalog probe.
 */
export async function verifyWorkCalendarSchema(source: DataSource): Promise<void> {
  const found = await source.query<unknown[]>(
    `SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass($1) AND conname = $2 AND contype = 'c' AND convalidated`,
    ['public.work_calendar_change', 'ck_work_calendar_change_kind'],
  );
  if (found.length !== 1) throw new Error('Work calendar schema drift');
}

/** Exact ACL of product_object_owner: what hr_register_object can do as its definer. */
const objectOwnerAcl = ['schema:public:USAGE', 'table:object_ref:INSERT', registerObject];

/**
 * Fails readiness when the HR registration function, its owner or the scope views drift: a wider
 * definer or a rewritten view would widen what every HR grant reaches. Read-only catalog probe.
 */
export async function verifyHrProtection(source: DataSource): Promise<void> {
  const [fn] = await source.query<
    {
      owner: string;
      definer: boolean;
      volatility: string;
      body: string;
      config: string[] | null;
      unsafe: boolean;
    }[]
  >(
    `SELECT r.rolname AS owner,p.prosecdef AS definer,p.provolatile AS volatility,p.prosrc AS body,p.proconfig AS config,
       (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
        OR has_schema_privilege(r.oid,'public','CREATE') OR EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid)) AS unsafe
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
      WHERE n.nspname='public' AND p.proname='hr_register_object' AND oidvectortypes(p.proargtypes)='text, uuid'`,
  );
  const acl = await functionOwnerGrants(source, 'product_object_owner');
  if (
    fn?.owner !== 'product_object_owner' ||
    !fn.definer ||
    fn.volatility !== 'v' ||
    fn.body !== hrRegisterObjectBodyT3 ||
    fn.config?.join('|') !== 'search_path=pg_catalog, pg_temp' ||
    fn.unsafe ||
    acl.size !== objectOwnerAcl.length ||
    objectOwnerAcl.some((grant) => !acl.has(grant))
  )
    throw new Error('HR protection drift');
  const views = await source.query<{ name: string; definition: string; invoker: boolean }[]>(
    `SELECT c.relname AS name,pg_get_viewdef(c.oid,false) AS definition,
       COALESCE(c.reloptions @> ARRAY['security_invoker=true'],false) AS invoker
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='v' AND c.relname=ANY($1)`,
    [Object.keys(hrViews)],
  );
  if (
    views.length !== Object.keys(hrViews).length ||
    views.some((view) => !view.invoker || view.definition !== hrScopeViewDefinitions[view.name])
  )
    throw new Error('HR protection drift');
}

/**
 * PostgreSQL 18 `pg_get_viewdef` output of the views migration HR installs (captured from a
 * disposable database; a PostgreSQL major upgrade re-checks these texts).
 */
const hrScopeViewDefinitions: Readonly<Record<string, string>> = {
  hr_employee_lead:
    ' SELECT m.employee_id,\n    e.account_id AS lead_account_id\n   FROM ((team_membership m\n     JOIN team_lead_assignment l ON ((l.team_id = m.team_id)))\n     JOIN employee e ON ((e.id = l.lead_employee_id)))\n  WHERE ((e.account_id IS NOT NULL) AND (m.starts_at <= statement_timestamp()) AND ((m.ends_at IS NULL) OR (m.ends_at > statement_timestamp())) AND (l.starts_at <= statement_timestamp()) AND ((l.ends_at IS NULL) OR (l.ends_at > statement_timestamp())));',
  hr_request_decider:
    " SELECT request_id,\n    actor_account_id\n   FROM request_decision d\n  WHERE (actor_kind = 'user'::text);",
  hr_request_lead:
    ' SELECT r.id AS request_id,\n    e.account_id AS lead_account_id\n   FROM (((work_request r\n     JOIN team_membership m ON (((m.employee_id = r.employee_id) AND (m.starts_at <= statement_timestamp()) AND ((m.ends_at IS NULL) OR (m.ends_at > statement_timestamp())) AND ((m.team_id = r.team_id) OR (m.is_primary AND (NOT (EXISTS ( SELECT 1\n           FROM team_membership c\n          WHERE ((c.employee_id = r.employee_id) AND (c.team_id = r.team_id) AND (c.starts_at <= statement_timestamp()) AND ((c.ends_at IS NULL) OR (c.ends_at > statement_timestamp())))))))))))\n     JOIN team_lead_assignment l ON (((l.team_id = m.team_id) AND (l.starts_at <= statement_timestamp()) AND ((l.ends_at IS NULL) OR (l.ends_at > statement_timestamp())))))\n     JOIN employee e ON ((e.id = l.lead_employee_id)))\n  WHERE (e.account_id IS NOT NULL);',
  hr_request_owner:
    ' SELECT r.id AS request_id,\n    e.account_id\n   FROM (work_request r\n     JOIN employee e ON ((e.id = r.employee_id)))\n  WHERE (e.account_id IS NOT NULL);',
  hr_team_lead:
    ' SELECT l.team_id,\n    e.account_id AS lead_account_id\n   FROM (team_lead_assignment l\n     JOIN employee e ON ((e.id = l.lead_employee_id)))\n  WHERE ((e.account_id IS NOT NULL) AND (l.starts_at <= statement_timestamp()) AND ((l.ends_at IS NULL) OR (l.ends_at > statement_timestamp())));',
  hr_employee_owner:
    ' SELECT id AS employee_id,\n    account_id\n   FROM employee e\n  WHERE (account_id IS NOT NULL);',
  hr_leave_rate_owner:
    ' SELECT r.id AS rate_id,\n    e.account_id\n   FROM (leave_rate r\n     JOIN employee e ON ((e.id = r.employee_id)))\n  WHERE (e.account_id IS NOT NULL);',
  hr_team_member:
    ' SELECT m.team_id,\n    e.account_id\n   FROM (team_membership m\n     JOIN employee e ON ((e.id = m.employee_id)))\n  WHERE ((e.account_id IS NOT NULL) AND (m.starts_at <= statement_timestamp()) AND ((m.ends_at IS NULL) OR (m.ends_at > statement_timestamp())));',
};

/** Registers a new HR record in the object registry (create on an authorized parent). */
export async function registerHrObject(
  tx: ProductTransaction,
  resource: 'employee' | 'team' | 'workRequest' | 'employeeIdentity' | 'leaveRate',
  key: string,
): Promise<string> {
  const [row] = await tx.manager.query<{ object_id: string }[]>(
    'SELECT public.hr_register_object($1,CAST($2 AS uuid))::text AS object_id',
    [resource, key],
  );
  if (!row) throw new Error('Object registration returned no row');
  return row.object_id;
}

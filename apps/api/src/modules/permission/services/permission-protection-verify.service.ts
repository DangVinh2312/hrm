import type { DataSource } from 'typeorm';
import { functionOwnerGrants } from '../../../database/services/product-privilege-verify.service.js';
import { registerObjectBody } from '../../../database/migrations/002-application-baseline.migration.js';
import { permissionViews, registerObjectPrivilege } from '../permission-database.helper.js';

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

/**
 * Fails readiness when the append-only triggers of the setting history (migration 113) are missing
 * or disabled: row UPDATE/DELETE and TRUNCATE must both be stopped for every login, the owner
 * included (ADR 0041 §5). Names and enabled state only; read-only catalog probe.
 */
export async function verifySettingSchema(source: DataSource): Promise<void> {
  const found = await source.query<unknown[]>(
    `SELECT 1 FROM pg_trigger
      WHERE tgrelid = to_regclass($1) AND NOT tgisinternal AND tgenabled = 'O'
        AND tgname IN ('forbid_setting_history_row_change', 'forbid_setting_history_truncate')`,
    ['public.system_setting_history'],
  );
  if (found.length !== 2) throw new Error('Setting schema drift');
}

/** Exact ACL of product_object_owner: what hr_register_object can do as its definer. */
const objectOwnerAcl = ['schema:public:USAGE', 'table:object_ref:INSERT', registerObjectPrivilege];

/**
 * Fails readiness when the HR registration function, its owner or the scope views drift: a wider
 * definer or a rewritten view would widen what every HR grant reaches. Read-only catalog probe.
 */
export async function verifyPermissionProtection(source: DataSource): Promise<void> {
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
    fn.body !== registerObjectBody ||
    fn.config?.join('|') !== 'search_path=pg_catalog, pg_temp' ||
    fn.unsafe ||
    acl.size !== objectOwnerAcl.length ||
    objectOwnerAcl.some((grant) => !acl.has(grant))
  )
    throw new Error('Permission protection drift');
  const views = await source.query<{ name: string; definition: string; invoker: boolean }[]>(
    `SELECT c.relname AS name,pg_get_viewdef(c.oid,false) AS definition,
       COALESCE(c.reloptions @> ARRAY['security_invoker=true'],false) AS invoker
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='v' AND c.relname=ANY($1)`,
    [Object.keys(permissionViews)],
  );
  if (
    views.length !== Object.keys(permissionViews).length ||
    views.some((view) => !view.invoker || view.definition !== scopeViewDefinitions[view.name])
  )
    throw new Error('Permission protection drift');
}

/**
 * PostgreSQL 18 `pg_get_viewdef` output of the views migration HR installs (captured from a
 * disposable database; a PostgreSQL major upgrade re-checks these texts).
 */
const scopeViewDefinitions: Readonly<Record<string, string>> = {
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
  hr_request_lead_rejected:
    " SELECT id AS request_id,\n    owner_account_id\n   FROM work_request r\n  WHERE ((state = 'rejected'::text) AND (EXISTS ( SELECT 1\n           FROM request_decision d\n          WHERE ((d.request_id = r.id) AND (d.stage = 'lead'::text) AND (d.decision = 'reject'::text) AND (d.actor_kind = 'user'::text)))) AND (EXISTS ( SELECT 1\n           FROM team_lead_assignment l\n          WHERE ((l.lead_employee_id = r.employee_id) AND (l.starts_at <= statement_timestamp()) AND ((l.ends_at IS NULL) OR (l.ends_at > statement_timestamp()))))));",
  hr_team_member:
    ' SELECT m.team_id,\n    e.account_id\n   FROM (team_membership m\n     JOIN employee e ON ((e.id = m.employee_id)))\n  WHERE ((e.account_id IS NOT NULL) AND (m.starts_at <= statement_timestamp()) AND ((m.ends_at IS NULL) OR (m.ends_at > statement_timestamp())));',
};

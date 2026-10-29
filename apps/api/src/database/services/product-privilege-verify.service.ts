import type { DataSource } from 'typeorm';
import { grantsOf, productFunctionOwners } from '../helpers/product-database.helper.js';
import {
  accountDirectoryDefinition,
  accountOwnerAcl,
  expectedPrivileges,
  iamAccountDefinition,
  protectedTables,
  protectionFunctions,
  protectionTriggers,
  sessionOwnerAcl,
  type RuntimePurpose,
} from '../product-privilege.declarations.js';

/**
 * Exact ACL (schema grants included) of one NOLOGIN function owner, for application probes of the
 * SECURITY DEFINER functions they install (e.g. HR object registration).
 */
export async function functionOwnerGrants(
  source: DataSource,
  owner: (typeof productFunctionOwners)[number],
): Promise<ReadonlySet<string>> {
  if (!productFunctionOwners.includes(owner)) throw new TypeError('Unknown function owner');
  const rows = await source.query<{ grant: string }[]>(
    grantsOf(`SELECT oid FROM pg_roles WHERE rolname='${owner}'`, true),
  );
  return new Set(rows.map((row) => row.grant));
}

/**
 * Startup probe fails closed if credentials or narrow DB capabilities drift. Every table, column
 * and function grant held directly or through PUBLIC in any non-system schema must equal the
 * expected set plus `additional` grants on application-owned tables. Owning any object or
 * schema, or CREATE on the database, is unsafe.
 */
export async function verifyProductPrivileges(
  pools: Readonly<Partial<Record<RuntimePurpose, DataSource>>>,
  additional: Readonly<Partial<Record<RuntimePurpose, readonly string[]>>> = {},
): Promise<void> {
  for (const purpose of Object.keys(pools) as RuntimePurpose[]) {
    const source = pools[purpose];
    if (!source) throw new Error('Missing product pool');
    const [role] = await source.query<
      { name: string; unsafe: boolean }[]
    >(`SELECT current_user AS name,
      (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
       OR EXISTS(SELECT FROM pg_namespace n WHERE has_schema_privilege(current_user,n.oid,'CREATE'))
       OR has_database_privilege(current_user,current_database(),'CREATE')
       OR has_database_privilege(current_user,current_database(),'TEMP')
       -- a login must not be able to re-delegate the access it holds
       OR EXISTS(SELECT FROM pg_namespace n WHERE has_schema_privilege(current_user,n.oid,'USAGE WITH GRANT OPTION'))
       OR has_database_privilege(current_user,current_database(),'CONNECT WITH GRANT OPTION')
       -- replica mode skips every protection trigger
       OR has_parameter_privilege(current_user,'session_replication_role','SET')
       OR current_setting('session_replication_role')<>'origin'
       OR EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid)
       OR EXISTS(SELECT FROM pg_namespace n WHERE n.nspowner=r.oid)
       OR EXISTS(SELECT FROM pg_proc p WHERE p.proowner=r.oid)
       OR EXISTS(SELECT FROM pg_class c WHERE c.relowner=r.oid)) AS unsafe
       FROM pg_roles r WHERE r.rolname=current_user`);
    if (role?.name !== `product_${purpose}` || role.unsafe)
      throw new Error('Unsafe product credential');
    const granted = await source.query<{ grant: string }[]>(
      grantsOf('0,(SELECT oid FROM pg_roles WHERE rolname=current_user)', false),
    );
    const actual = new Set(granted.map((g) => g.grant));
    const expected = new Set([...expectedPrivileges[purpose], ...(additional[purpose] ?? [])]);
    const unexpected = [...actual].filter((g) => !expected.has(g));
    const missing = [...expected].filter((g) => !actual.has(g));
    if (unexpected.length || missing.length)
      throw new Error(
        `Product privilege drift for ${purpose}: unexpected [${unexpected.sort().join(', ')}], missing [${missing.sort().join(', ')}]`,
      );
    const [hardening] = await source.query<{ valid: boolean }[]>(`SELECT
      (SELECT count(*)=2 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
        WHERE n.nspname='public' AND p.proname IN ('authz_acquire_shared_fence','resolve_session')
          AND p.prosecdef AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolbypassrls AND NOT r.rolreplication
          AND NOT has_schema_privilege(r.oid,'public','CREATE') AND NOT EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid)
          AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) AS valid`);
    if (!hardening?.valid) throw new Error('Product protection drift');
    const ownerGrants = await source.query<{ grant: string }[]>(
      grantsOf("SELECT oid FROM pg_roles WHERE rolname='product_session_owner'", true),
    );
    const ownerActual = new Set(ownerGrants.map((g) => g.grant));
    if (
      ownerActual.size !== sessionOwnerAcl.length ||
      sessionOwnerAcl.some((g) => !ownerActual.has(g))
    )
      throw new Error('Product protection drift');
    const [view] = await source.query<{ valid: boolean }[]>(
      `SELECT pg_get_viewdef(c.oid,false)=$1 AND COALESCE(c.reloptions @> ARRAY['security_invoker=true'],false) AS valid
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='iam_account' AND c.relkind='v'`,
      [iamAccountDefinition],
    );
    if (!view?.valid) throw new Error('Product protection drift');
    const [directory] = await source.query<{ valid: boolean }[]>(
      `SELECT pg_get_viewdef(c.oid,false)=$1 AND r.rolname='product_account_owner'
          AND c.reloptions=ARRAY['security_barrier=true']
          AND NOT (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
            OR has_schema_privilege(r.oid,'public','CREATE') OR EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid)) AS valid
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
        WHERE n.nspname='public' AND c.relname='account_directory' AND c.relkind='v'`,
      [accountDirectoryDefinition],
    );
    const accountOwner = await functionOwnerGrants(source, 'product_account_owner');
    if (
      !directory?.valid ||
      accountOwner.size !== accountOwnerAcl.length ||
      accountOwnerAcl.some((g) => !accountOwner.has(g))
    )
      throw new Error('Product protection drift');
    const functions = await source.query<
      {
        name: string;
        owner: string;
        definer: boolean;
        volatility: string;
        body: string;
        config: string[] | null;
      }[]
    >(
      `SELECT p.proname AS name,r.rolname AS owner,p.prosecdef AS definer,p.provolatile AS volatility,p.prosrc AS body,p.proconfig AS config
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
        WHERE n.nspname='public' AND p.proname=ANY($1)`,
      [Object.keys(protectionFunctions)],
    );
    const triggers = await source.query<{ trigger: string }[]>(
      `SELECT c.relname||'.'||t.tgname||':'
          ||CASE WHEN fn.nspname='public' AND t.tgqual IS NULL AND t.tgnargs=0 THEN p.proname ELSE '(unexpected)' END||':'
          ||t.tgtype::text||':'
          ||COALESCE((SELECT string_agg(a.attname,',' ORDER BY a.attname) FROM pg_attribute a
            WHERE a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr)),'')||':'
          ||t.tgenabled::text||':'||t.tgdeferrable::text||':'||t.tginitdeferred::text AS trigger
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace fn ON fn.oid=p.pronamespace
        WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname=ANY($1)`,
      [protectedTables],
    );
    const actualTriggers = new Set(triggers.map((t) => t.trigger));
    if (
      functions.length !== Object.keys(protectionFunctions).length ||
      functions.some(({ name, owner, definer, volatility, body, config }) => {
        const [expectedOwner, expectedDefiner, expectedBody] = protectionFunctions[name]!;
        return (
          owner !== expectedOwner ||
          definer !== expectedDefiner ||
          volatility !== 'v' ||
          body !== expectedBody ||
          config?.join('|') !== 'search_path=pg_catalog, pg_temp'
        );
      }) ||
      actualTriggers.size !== triggers.length ||
      actualTriggers.size !== protectionTriggers.size ||
      [...protectionTriggers].some((t) => !actualTriggers.has(t))
    )
      throw new Error('Product protection drift');
  }
}

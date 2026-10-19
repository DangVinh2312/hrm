import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Body of `public.provision_oidc_account` (ADR 0020 §3). It only creates a pending IAM account
 * with its canonical email and a 7-day email enrollment at an enabled provider: it never changes
 * an existing account, never binds a subject and never grants anything. A duplicate email (either
 * table) is the unique violation 23505 the caller maps to 409. The JS canonical form
 * (`canonicalLoginEmail`) is checked first; this is the database's own fail-closed copy.
 */
export const provisionOidcAccountBody = `
BEGIN
  IF p_user IS NULL OR p_actor IS NULL OR p_email IS NULL OR p_issuer IS NULL
    OR char_length(p_email) > 254 OR p_email <> lower(p_email)
    OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
    RAISE EXCEPTION 'invalid account provisioning input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT FROM public.oidc_provider WHERE issuer = p_issuer AND enabled) THEN
    RAISE EXCEPTION 'issuer is not an enabled provider' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.app_user(id, email_canonical, state) VALUES (p_user, p_email, 'pending');
  INSERT INTO public.oidc_email_enrollment(user_id, issuer, email_canonical, expires_at, created_by)
    VALUES (p_user, p_issuer, p_email, statement_timestamp() + interval '7 days', p_actor);
END`;

/**
 * Projection of IAM accounts for `account.read`/`account.suspend` (ADR 0020 §4): email, state and
 * the enrollment status only. Owner rights (not security_invoker) so the runtime logins read these
 * columns through the view and never `app_user.email_canonical` itself; `security_barrier` keeps a
 * caller's predicate from seeing Root rows before `kind = 'iam'` filters them.
 */
export const accountDirectoryView = `SELECT u.id, u.email_canonical AS email, u.state, CASE WHEN e.user_id IS NULL THEN NULL WHEN e.expires_at > statement_timestamp() THEN 'pending' ELSE 'expired' END AS enrollment FROM public.app_user u LEFT JOIN public.oidc_email_enrollment e ON e.user_id = u.id WHERE u.kind = 'iam'`;

/**
 * OIDC account provisioning by email (ADR 0020): the identity key stays `(issuer, sub)`; the email
 * is a one-time enrollment claim consumed by the first verified login. Needs the NOLOGIN
 * `product_account_owner`, so it runs through `db:provision` like the other owner-changing
 * migrations.
 */
export class ProductOidcEmailEnrollment1792108800013 implements MigrationInterface {
  name = 'ProductOidcEmailEnrollment1792108800013';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE public.oidc_email_enrollment(
        user_id uuid PRIMARY KEY REFERENCES public.app_user(id),
        issuer text NOT NULL REFERENCES public.oidc_provider(issuer),
        email_canonical text NOT NULL CHECK (char_length(email_canonical) BETWEEN 3 AND 254 AND email_canonical = lower(email_canonical)),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        -- Actor id as in audit_outbox.actor_id (a Root/IAM user or the offline actor); no FK.
        created_by uuid NOT NULL,
        CONSTRAINT uq_oidc_email_enrollment UNIQUE (issuer, email_canonical),
        CONSTRAINT ck_oidc_email_enrollment_window CHECK (expires_at > created_at)
      );
      REVOKE ALL ON public.oidc_email_enrollment FROM PUBLIC;
      -- Identity binds at the first verified login (lock the account, consume the row) and the
      -- offline CLI enrolls with the identity login like its other enroll paths.
      GRANT SELECT,INSERT,DELETE ON public.oidc_email_enrollment TO product_identity;
      -- Definer rights: exactly what the view and the function read or insert (probed exactly).
      GRANT SELECT(id,email_canonical,state,kind),INSERT(id,email_canonical,state) ON public.app_user TO product_account_owner;
      GRANT SELECT(issuer,enabled) ON public.oidc_provider TO product_account_owner;
      GRANT SELECT(user_id,expires_at),INSERT ON public.oidc_email_enrollment TO product_account_owner;
      CREATE VIEW public.account_directory WITH (security_barrier=true) AS ${accountDirectoryView};
      REVOKE ALL ON public.account_directory FROM PUBLIC;
      GRANT SELECT ON public.account_directory TO product_data,product_authority;
      ALTER VIEW public.account_directory OWNER TO product_account_owner;
      CREATE FUNCTION public.provision_oidc_account(p_user uuid, p_email text, p_issuer text, p_actor uuid) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${provisionOidcAccountBody}$fn$;
      REVOKE ALL ON FUNCTION public.provision_oidc_account(uuid,text,text,uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.provision_oidc_account(uuid,text,text,uuid) TO product_data;
      ALTER FUNCTION public.provision_oidc_account(uuid,text,text,uuid) OWNER TO product_account_owner;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

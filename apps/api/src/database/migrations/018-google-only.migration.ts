import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Exact body of `public.resolve_session` from this migration on (ADR 0027 §2): OIDC sessions
 * only. The local branch and its join to `local_credential` are gone; the return type is the one
 * migration 012 set, so every caller reads the same columns.
 */
export const resolveSessionOidcBody = `
        SELECT u.id,u.kind,u.state,u.auth_epoch,s.method,s.assurance,s.authenticated_at,s.reauthenticated_at,s.expires_at
        FROM public.application_session s JOIN public.app_user u ON u.id=s.user_id
        JOIN public.external_identity e ON e.issuer=s.external_issuer AND e.subject=s.external_subject AND e.user_id=u.id
        WHERE s.token_hash=p_digest AND u.state='active' AND s.auth_epoch=u.auth_epoch
          AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND s.last_seen_at>statement_timestamp()-interval '30 minutes'
          AND s.method='oidc' AND e.enabled AND e.binding_version=s.binding_version
          AND EXISTS (SELECT FROM public.oidc_provider p WHERE p.issuer=e.issuer AND p.enabled AND p.version=s.provider_version)
        `;

/** `guard_root_kind` of migration 012 with the OIDC activation purpose only. */
export const guardRootKindOidcBody = `
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.kind='root' THEN
      RAISE EXCEPTION 'Root accounts are created only by promotion' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind IS NOT DISTINCT FROM OLD.kind THEN RETURN NEW; END IF;
  IF NOT (OLD.kind='iam' AND NEW.kind='root') THEN
    RAISE EXCEPTION 'account kind is immutable except the one Root promotion' USING ERRCODE='42501';
  END IF;
  IF session_user<>'product_bootstrap' THEN
    RAISE EXCEPTION 'Root promotion is offline bootstrap only' USING ERRCODE='42501';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Root promotion requires READ COMMITTED' USING ERRCODE='42501';
  END IF;
  IF OLD.state<>'pending' THEN
    RAISE EXCEPTION 'Root promotion target must be pending' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT FROM public.security_bootstrap_state WHERE singleton AND initialized_at IS NOT NULL)
    OR EXISTS(SELECT FROM public.app_user WHERE kind='root') THEN
    RAISE EXCEPTION 'Root promotion is one-time' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT FROM public.user_role WHERE user_id=NEW.id)
    OR EXISTS(SELECT FROM public.user_boundary WHERE user_id=NEW.id)
    OR EXISTS(SELECT FROM public.policy_rule WHERE user_id=NEW.id)
    OR EXISTS(SELECT FROM public.record_exception WHERE user_id=NEW.id) THEN
    RAISE EXCEPTION 'Root promotion target holds IAM facts' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT FROM public.one_time_token WHERE user_id=NEW.id AND purpose='oidc-activation'
      AND consumed_at IS NULL AND expires_at>statement_timestamp()) THEN
    RAISE EXCEPTION 'Root promotion target holds a live activation token' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/** `guard_root_activation` of migration 012 with the OIDC activation purpose only. */
export const guardRootActivationOidcBody = `
DECLARE v_kind text;
BEGIN
  IF NEW.purpose='oidc-activation' THEN
    SELECT kind INTO v_kind FROM public.app_user WHERE id=NEW.user_id FOR SHARE;
    IF v_kind='root' AND session_user<>'product_bootstrap' THEN
      RAISE EXCEPTION 'Root activation is issued by the bootstrap credential only' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END`;

/**
 * Google only (ADR 0027 §2), one forward migration. Replaces functions of the owner role
 * `product_session_owner`, so it applies through `provision` (temporary owner membership), not
 * through `migrate` alone.
 * - Preflight first, before any change; a violation needs a reviewed manual fix (dev data):
 *   an active account whose only usable way in is a local password (no enabled binding at an
 *   enabled provider), or a pending Root without a Google binding to activate with.
 * - Local tokens (`activation`, `reset`) and local sessions are deleted before the CHECKs narrow:
 *   tokens to `oidc-activation`, sessions to `oidc` with every OIDC column NOT NULL; the session
 *   `credential_version` column goes (the token column stays: `protect_token_consumption` names it).
 * - `resolve_session`, `guard_root_kind` and `guard_root_activation` lose their local branches.
 * - `local_credential` is dropped with its grants (identity, bootstrap, session owner).
 */
export class ProductGoogleOnly1792108800018 implements MigrationInterface {
  name = 'ProductGoogleOnly1792108800018';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DO $preflight$ BEGIN
        IF EXISTS (SELECT 1 FROM public.app_user u WHERE u.state='active'
            AND EXISTS (SELECT 1 FROM public.local_credential c WHERE c.user_id=u.id)
            AND NOT EXISTS (SELECT 1 FROM public.external_identity e JOIN public.oidc_provider p ON p.issuer=e.issuer AND p.enabled
              WHERE e.user_id=u.id AND e.enabled)) THEN
          RAISE EXCEPTION 'an active account signs in with a local password only; bind its Google account by a reviewed manual change first';
        END IF;
        IF EXISTS (SELECT 1 FROM public.app_user u WHERE u.kind='root' AND u.state='pending'
            AND NOT EXISTS (SELECT 1 FROM public.external_identity e JOIN public.oidc_provider p ON p.issuer=e.issuer AND p.enabled
              WHERE e.user_id=u.id AND e.enabled)) THEN
          RAISE EXCEPTION 'the pending Root has no Google binding to activate with; bind it by a reviewed manual change first';
        END IF;
      END $preflight$;
    `);
    // resolve_session first: its old body reads the column and the table dropped below. As in
    // 012, the owner role drops its function and the migration login recreates and hands it back.
    await runner.query(`
      SET LOCAL ROLE product_session_owner;
      DROP FUNCTION public.resolve_session(bytea);
      RESET ROLE;
      CREATE FUNCTION public.resolve_session(p_digest bytea)
        RETURNS TABLE(user_id uuid,kind text,state text,auth_epoch bigint,method text,assurance text,authenticated_at timestamptz,reauthenticated_at timestamptz,expires_at timestamptz)
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${resolveSessionOidcBody}$fn$;
      REVOKE ALL ON FUNCTION public.resolve_session(bytea) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.resolve_session(bytea) TO product_data,product_identity,product_authority;
      ALTER FUNCTION public.resolve_session(bytea) OWNER TO product_session_owner;
    `);
    // Same order as 012/016 for the two guards: drop trigger, owner drops function, recreate,
    // trigger, revoke, owner back.
    await runner.query(`
      DROP TRIGGER guard_root_kind ON public.app_user;
      DROP TRIGGER guard_root_activation ON public.one_time_token;
      SET LOCAL ROLE product_session_owner;
      DROP FUNCTION public.guard_root_kind();
      DROP FUNCTION public.guard_root_activation();
      RESET ROLE;
      CREATE FUNCTION public.guard_root_kind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path=pg_catalog,pg_temp AS $fn$${guardRootKindOidcBody}$fn$;
      CREATE FUNCTION public.guard_root_activation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path=pg_catalog,pg_temp AS $fn$${guardRootActivationOidcBody}$fn$;
      CREATE TRIGGER guard_root_kind BEFORE INSERT OR UPDATE OF kind ON public.app_user
        FOR EACH ROW EXECUTE FUNCTION public.guard_root_kind();
      CREATE TRIGGER guard_root_activation BEFORE INSERT ON public.one_time_token
        FOR EACH ROW EXECUTE FUNCTION public.guard_root_activation();
      REVOKE ALL ON FUNCTION public.guard_root_kind(), public.guard_root_activation() FROM PUBLIC;
      ALTER FUNCTION public.guard_root_kind() OWNER TO product_session_owner;
      ALTER FUNCTION public.guard_root_activation() OWNER TO product_session_owner;
    `);
    await runner.query(`
      DELETE FROM public.one_time_token WHERE purpose IN ('activation','reset');
      ALTER TABLE public.one_time_token DROP CONSTRAINT one_time_token_purpose_check;
      ALTER TABLE public.one_time_token ADD CONSTRAINT one_time_token_purpose_check
        CHECK (purpose='oidc-activation');
      DELETE FROM public.application_session WHERE method='local';
      ALTER TABLE public.application_session DROP CONSTRAINT application_session_check1;
      ALTER TABLE public.application_session DROP CONSTRAINT application_session_method_check;
      ALTER TABLE public.application_session DROP COLUMN credential_version;
      ALTER TABLE public.application_session ADD CONSTRAINT application_session_method_check
        CHECK (method='oidc');
      ALTER TABLE public.application_session ALTER COLUMN external_issuer SET NOT NULL,
        ALTER COLUMN external_subject SET NOT NULL, ALTER COLUMN binding_version SET NOT NULL,
        ALTER COLUMN provider_version SET NOT NULL;
      DROP TABLE public.local_credential;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

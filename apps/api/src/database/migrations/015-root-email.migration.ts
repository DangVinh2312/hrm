import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Exact body of `public.require_email_epoch` (ADR 0023 §4); the startup probe compares it. A link
 * proof carries the account's auth_epoch, not its email, and a session outlives a changed email:
 * so any change of `email_canonical` or `email_verified` must advance `auth_epoch` in the same
 * row update, for every login including the owner and a superuser.
 */
export const requireEmailEpochBody = `
BEGIN
  IF (NEW.email_canonical IS DISTINCT FROM OLD.email_canonical
      OR NEW.email_verified IS DISTINCT FROM OLD.email_verified)
    AND NEW.auth_epoch <= OLD.auth_epoch THEN
    RAISE EXCEPTION 'an email change must end the account sessions' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/**
 * `public.guard_root_lifecycle` from migration 012, narrowed open for one offline case (ADR 0023
 * §4, ADR 0012 amended): bootstrap may also give the Root a new, unverified email, with the same
 * state and a new auth_epoch. Everything else stays: bootstrap never touches IAM accounts, may
 * otherwise only suspend Root, and other logins than identity never change Root lifecycle.
 */
export const guardRootLifecycleBody = `
BEGIN
  IF OLD.kind='iam' THEN
    IF session_user='product_bootstrap' THEN
      RAISE EXCEPTION 'bootstrap may not change IAM account lifecycle' USING ERRCODE='42501';
    END IF;
  ELSIF session_user='product_bootstrap' THEN
    IF NEW.auth_epoch<=OLD.auth_epoch OR NOT (NEW.state='suspended'
        OR (NEW.state=OLD.state AND NEW.email_canonical IS NOT NULL
          AND NEW.email_canonical IS DISTINCT FROM OLD.email_canonical AND NOT NEW.email_verified)) THEN
      RAISE EXCEPTION 'bootstrap may only suspend Root, or give it a new unverified email, and end its sessions' USING ERRCODE='42501';
    END IF;
  ELSIF session_user<>'product_identity' THEN
    RAISE EXCEPTION 'Root lifecycle is offline or identity only' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/**
 * Root email and binding hardening (ADR 0023 §2, §4), one forward migration:
 * - `require_email_epoch`: an email change advances auth_epoch (owner-rights trigger, like 014);
 * - bootstrap gets UPDATE(email_canonical, email_verified) on `app_user` for `set-root-email`,
 *   bounded by the replaced Root guard above and by `require_email_epoch`;
 * - identity loses table DELETE on `external_identity`: no code deletes a binding, and a deleted
 *   then re-inserted tuple would come back under a new `binding_ref`.
 * Replacing the guard needs the owner role, so this migration applies through `provision`
 * (temporary owner membership), not through `migrate` alone.
 */
export class ProductRootEmail1792108800015 implements MigrationInterface {
  name = 'ProductRootEmail1792108800015';

  async up(runner: QueryRunner): Promise<void> {
    // As in 012: the owner role drops its function, the migration login recreates it and hands
    // it back; the trigger is recreated unchanged in the same transaction.
    await runner.query(`
      DROP TRIGGER guard_root_lifecycle ON public.app_user;
      SET LOCAL ROLE product_session_owner;
      DROP FUNCTION public.guard_root_lifecycle();
      RESET ROLE;
      CREATE FUNCTION public.guard_root_lifecycle() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${guardRootLifecycleBody}$fn$;
      CREATE TRIGGER guard_root_lifecycle BEFORE UPDATE OF state,auth_epoch ON public.app_user
        FOR EACH ROW EXECUTE FUNCTION public.guard_root_lifecycle();
      REVOKE ALL ON FUNCTION public.guard_root_lifecycle() FROM PUBLIC;
      ALTER FUNCTION public.guard_root_lifecycle() OWNER TO product_session_owner;
      CREATE FUNCTION public.require_email_epoch() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,pg_temp AS $fn$${requireEmailEpochBody}$fn$;
      REVOKE ALL ON FUNCTION public.require_email_epoch() FROM PUBLIC;
      CREATE TRIGGER require_email_epoch BEFORE UPDATE OF email_canonical,email_verified ON public.app_user
        FOR EACH ROW EXECUTE FUNCTION public.require_email_epoch();
      GRANT UPDATE(email_canonical,email_verified) ON public.app_user TO product_bootstrap;
      REVOKE DELETE ON public.external_identity FROM product_identity;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

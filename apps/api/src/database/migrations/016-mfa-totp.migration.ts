import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Exact body of `public.protect_mfa_totp` (ADR 0026 §4); the startup probe compares it. A second
 * factor starts unconfirmed; confirmation happens once and is never undone by an UPDATE (removal
 * is a DELETE, which `mfa_epoch` turns into new sessions); a confirmed secret keeps its version and
 * setup time; the last used step never goes back. Bootstrap may only delete the Root's factor.
 * Ciphertext, nonce and key id stay writable so a verify can re-encrypt under the current key.
 */
export const protectMfaTotpBody = `
DECLARE v_kind text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.confirmed_at IS NOT NULL OR NEW.last_used_step IS NOT NULL OR NEW.failed_attempts<>0
      OR NEW.secret_version<>1 THEN
      RAISE EXCEPTION 'a second factor starts unconfirmed' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF session_user='product_bootstrap' THEN
      SELECT kind INTO v_kind FROM public.app_user WHERE id=OLD.user_id;
      IF v_kind IS DISTINCT FROM 'root' THEN
        RAISE EXCEPTION 'bootstrap may only reset the Root second factor' USING ERRCODE='42501';
      END IF;
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.user_id<>OLD.user_id OR NEW.secret_version<OLD.secret_version
    OR (OLD.confirmed_at IS NOT NULL AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
      OR NEW.secret_version<>OLD.secret_version OR NEW.created_at<>OLD.created_at))
    OR (OLD.last_used_step IS NOT NULL AND (NEW.last_used_step IS NULL OR NEW.last_used_step<OLD.last_used_step)) THEN
    RAISE EXCEPTION 'second factor facts only move forward' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/**
 * Exact body of `public.protect_mfa_recovery_code` (ADR 0026 §4, like `protect_token_consumption`):
 * codes start unused and an UPDATE only marks one used now; bootstrap may only delete Root codes.
 */
export const protectMfaRecoveryCodeBody = `
DECLARE v_kind text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.used_at IS NOT NULL THEN
      RAISE EXCEPTION 'recovery codes start unused' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.used_at IS NOT NULL OR NEW.used_at IS DISTINCT FROM statement_timestamp()
      OR (NEW.user_id,NEW.code_hash) IS DISTINCT FROM (OLD.user_id,OLD.code_hash) THEN
      RAISE EXCEPTION 'recovery codes may only be used once' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF session_user='product_bootstrap' THEN
    SELECT kind INTO v_kind FROM public.app_user WHERE id=OLD.user_id;
    IF v_kind IS DISTINCT FROM 'root' THEN
      RAISE EXCEPTION 'bootstrap may only reset the Root second factor' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN OLD;
END`;

/**
 * Exact body of `public.mfa_epoch` (ADR 0026 §4, §6): confirming or removing a second factor, and
 * each failed verify from the tenth on, ends every session of the account in the same statement.
 * `>=` keeps ending sessions once the counter sits at its cap (1000); every other UPDATE of a
 * confirmed factor (a success, a re-encryption) resets the counter to 0, so it never fires there.
 * Caller rights: a login that may write the factor but not `auth_epoch` is refused (fail closed).
 */
export const mfaEpochBody = `
BEGIN
  IF (TG_OP='DELETE' AND OLD.confirmed_at IS NOT NULL)
    OR (TG_OP='UPDATE' AND ((OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL)
      OR (NEW.failed_attempts>=10 AND NEW.failed_attempts>=OLD.failed_attempts))) THEN
    UPDATE public.app_user SET auth_epoch=auth_epoch+1 WHERE id=OLD.user_id;
  END IF;
  RETURN NULL;
END`;

/**
 * `public.guard_root_lifecycle` from migration 015 with one more offline case (ADR 0026 §4, §10):
 * bootstrap may end the Root's sessions without another change once the Root holds no second
 * factor — the state a `root:reset-mfa` leaves. An epoch alone grants nothing.
 */
export const guardRootLifecycleMfaBody = `
BEGIN
  IF OLD.kind='iam' THEN
    IF session_user='product_bootstrap' THEN
      RAISE EXCEPTION 'bootstrap may not change IAM account lifecycle' USING ERRCODE='42501';
    END IF;
  ELSIF session_user='product_bootstrap' THEN
    IF NEW.auth_epoch<=OLD.auth_epoch OR NOT (NEW.state='suspended'
        OR (NEW.state=OLD.state AND NEW.email_canonical IS NOT NULL
          AND NEW.email_canonical IS DISTINCT FROM OLD.email_canonical AND NOT NEW.email_verified)
        OR (NEW.state=OLD.state AND NEW.email_canonical IS NOT DISTINCT FROM OLD.email_canonical
          AND NEW.email_verified=OLD.email_verified
          AND NOT EXISTS(SELECT FROM public.mfa_totp WHERE user_id=NEW.id))) THEN
      RAISE EXCEPTION 'bootstrap may only suspend Root, give it a new unverified email, or end its sessions after a second factor reset' USING ERRCODE='42501';
    END IF;
  ELSIF session_user<>'product_identity' THEN
    RAISE EXCEPTION 'Root lifecycle is offline or identity only' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/**
 * TOTP second factor and recovery codes (ADR 0026), one forward migration:
 * - `mfa_totp`: one row per user, the secret sealed by the API (AES-256-GCM; key id only here);
 * - `mfa_recovery_code`: SHA-256 of one-time codes, keyed by (user, hash);
 * - guards above; identity reads and writes both tables, bootstrap only deletes Root rows;
 * - `guard_root_lifecycle` replaced like in 015, which needs the owner role: this migration applies
 *   through `provision` (temporary owner membership), not through `migrate` alone.
 */
export class ProductMfaTotp1792108800016 implements MigrationInterface {
  name = 'ProductMfaTotp1792108800016';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE public.mfa_totp(
        user_id uuid PRIMARY KEY REFERENCES public.app_user(id),
        secret_ciphertext bytea NOT NULL CHECK (octet_length(secret_ciphertext) = 36),
        nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
        key_id text NOT NULL CHECK (key_id ~ '^[a-z0-9-]{1,32}$'),
        secret_version bigint NOT NULL DEFAULT 1 CHECK (secret_version > 0),
        confirmed_at timestamptz,
        last_used_step bigint CHECK (last_used_step >= 0),
        failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 1000),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp()
      );
      CREATE TABLE public.mfa_recovery_code(
        user_id uuid NOT NULL REFERENCES public.app_user(id),
        code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
        used_at timestamptz,
        PRIMARY KEY (user_id, code_hash)
      );
      REVOKE ALL ON public.mfa_totp, public.mfa_recovery_code FROM PUBLIC;
      CREATE FUNCTION public.protect_mfa_totp() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,pg_temp AS $fn$${protectMfaTotpBody}$fn$;
      CREATE FUNCTION public.protect_mfa_recovery_code() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,pg_temp AS $fn$${protectMfaRecoveryCodeBody}$fn$;
      CREATE FUNCTION public.mfa_epoch() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,pg_temp AS $fn$${mfaEpochBody}$fn$;
      CREATE TRIGGER protect_mfa_totp BEFORE INSERT OR UPDATE OR DELETE ON public.mfa_totp
        FOR EACH ROW EXECUTE FUNCTION public.protect_mfa_totp();
      CREATE TRIGGER mfa_epoch AFTER UPDATE OR DELETE ON public.mfa_totp
        FOR EACH ROW EXECUTE FUNCTION public.mfa_epoch();
      CREATE TRIGGER protect_mfa_recovery_code BEFORE INSERT OR UPDATE OR DELETE ON public.mfa_recovery_code
        FOR EACH ROW EXECUTE FUNCTION public.protect_mfa_recovery_code();
      REVOKE ALL ON FUNCTION public.protect_mfa_totp(), public.protect_mfa_recovery_code(), public.mfa_epoch() FROM PUBLIC;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public.mfa_totp TO product_identity;
      GRANT SELECT,INSERT,DELETE ON public.mfa_recovery_code TO product_identity;
      GRANT UPDATE(used_at) ON public.mfa_recovery_code TO product_identity;
      GRANT SELECT(user_id),DELETE ON public.mfa_totp, public.mfa_recovery_code TO product_bootstrap;
      GRANT SELECT(user_id) ON public.mfa_totp TO product_session_owner;
    `);
    // As in 012/015: the owner role drops its function, the migration login recreates it and
    // hands it back; the trigger is recreated unchanged in the same transaction.
    await runner.query(`
      DROP TRIGGER guard_root_lifecycle ON public.app_user;
      SET LOCAL ROLE product_session_owner;
      DROP FUNCTION public.guard_root_lifecycle();
      RESET ROLE;
      CREATE FUNCTION public.guard_root_lifecycle() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${guardRootLifecycleMfaBody}$fn$;
      CREATE TRIGGER guard_root_lifecycle BEFORE UPDATE OF state,auth_epoch ON public.app_user
        FOR EACH ROW EXECUTE FUNCTION public.guard_root_lifecycle();
      REVOKE ALL ON FUNCTION public.guard_root_lifecycle() FROM PUBLIC;
      ALTER FUNCTION public.guard_root_lifecycle() OWNER TO product_session_owner;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

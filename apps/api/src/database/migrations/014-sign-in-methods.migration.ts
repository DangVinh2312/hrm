import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Exact body of `public.protect_binding_ref` (ADR 0023 §2); the startup probe compares it. The
 * reference a client names a binding by never changes, for any login including the owner: relink
 * of the same (issuer, subject) keeps it. Only a trigger disabled by the owner or replica mode
 * skips it, and the probe refuses both.
 */
export const protectBindingRefBody = `
BEGIN
  IF NEW.binding_ref IS DISTINCT FROM OLD.binding_ref THEN
    RAISE EXCEPTION 'binding reference is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/**
 * Sign-in methods and account linking (ADR 0023), all schema in one forward migration:
 * - `external_identity.binding_ref`: opaque, unique, immutable reference returned to the client
 *   instead of the provider subject; existing rows are backfilled (volatile default per row);
 * - identity writes `external_identity` by column only: INSERT(issuer, subject, user_id) and
 *   UPDATE(enabled, binding_version) — exactly what the service and the offline CLI write;
 * - `oidc_link_proof`: at most one pending link proof per session (PK = session hash). Purging or
 *   deleting the session removes it (FK cascade runs with the table owner's rights). Correctness
 *   comes from the recheck at confirmation; cleanup elsewhere is housekeeping. Only identity reads,
 *   inserts or deletes proofs; no login may update one.
 */
export class ProductSignInMethods1792108800014 implements MigrationInterface {
  name = 'ProductSignInMethods1792108800014';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE public.external_identity ADD COLUMN binding_ref uuid NOT NULL DEFAULT gen_random_uuid();
      ALTER TABLE public.external_identity ADD CONSTRAINT uq_external_identity_binding_ref UNIQUE (binding_ref);
      CREATE FUNCTION public.protect_binding_ref() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,pg_temp AS $fn$${protectBindingRefBody}$fn$;
      REVOKE ALL ON FUNCTION public.protect_binding_ref() FROM PUBLIC;
      CREATE TRIGGER protect_binding_ref BEFORE UPDATE ON public.external_identity
        FOR EACH ROW EXECUTE FUNCTION public.protect_binding_ref();
      REVOKE INSERT,UPDATE ON public.external_identity FROM product_identity;
      GRANT INSERT(issuer,subject,user_id),UPDATE(enabled,binding_version) ON public.external_identity TO product_identity;
      CREATE TABLE public.oidc_link_proof(
        session_hash bytea PRIMARY KEY REFERENCES public.application_session(token_hash) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES public.app_user(id),
        issuer text NOT NULL,
        subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 512),
        auth_epoch bigint NOT NULL CHECK (auth_epoch > 0),
        provider_version bigint NOT NULL CHECK (provider_version > 0),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        expires_at timestamptz NOT NULL DEFAULT statement_timestamp() + interval '5 minutes',
        CONSTRAINT ck_oidc_link_proof_window CHECK (expires_at = created_at + interval '5 minutes')
      );
      CREATE INDEX ix_oidc_link_proof_user ON public.oidc_link_proof(user_id);
      REVOKE ALL ON public.oidc_link_proof FROM PUBLIC;
      GRANT SELECT,INSERT,DELETE ON public.oidc_link_proof TO product_identity;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One Google binding per account, no link, unlink or Google step-up (ADR 0027 §6–7), one forward
 * migration. Applies through `migrate` (no function of an owner role changes).
 * - Preflight first, before any change: an account with more than one enabled binding needs a
 *   decision by hand (dev data, ADR 0027 §6); the migration never picks the binding to keep.
 * - `uq_external_identity_one_enabled`: at most one enabled binding per account, for every login.
 *   Disabled rows (history of earlier unlinks) stay and do not count.
 * - identity loses UPDATE(enabled, binding_version) on `external_identity`: only unlink and link
 *   confirmation wrote them; a later operator command for changing an account's Google gets its
 *   own reviewed grant.
 * - link and reauth attempts are deleted (they expire after 5 minutes anyway) before the purpose
 *   CHECK narrows to login/activation; their session column goes with them.
 * - `oidc_link_proof` is dropped with its grants.
 */
export class ProductSingleGoogleBinding1792108800017 implements MigrationInterface {
  name = 'ProductSingleGoogleBinding1792108800017';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DO $preflight$ BEGIN
        IF EXISTS (SELECT 1 FROM public.external_identity WHERE enabled GROUP BY user_id HAVING count(*) > 1) THEN
          RAISE EXCEPTION 'an account holds more than one enabled Google binding; disable the extra ones by a reviewed manual change first';
        END IF;
      END $preflight$;
    `);
    await runner.query(`
      CREATE UNIQUE INDEX uq_external_identity_one_enabled ON public.external_identity(user_id) WHERE enabled;
      REVOKE UPDATE(enabled,binding_version) ON public.external_identity FROM product_identity;
      DELETE FROM public.oidc_login_attempt WHERE purpose IN ('link','reauth');
      ALTER TABLE public.oidc_login_attempt DROP CONSTRAINT oidc_login_attempt_purpose_check;
      ALTER TABLE public.oidc_login_attempt ADD CONSTRAINT oidc_login_attempt_purpose_check
        CHECK (purpose IN ('login','activation'));
      ALTER TABLE public.oidc_login_attempt DROP COLUMN linking_session_hash;
      DROP TABLE public.oidc_link_proof;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

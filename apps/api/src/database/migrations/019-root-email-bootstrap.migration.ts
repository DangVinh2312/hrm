import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Root created from an email (ADR 0027 §3), one forward migration. Applies through `migrate`
 * (no function of an owner role changes; `guard_root_kind` still allows only the one promotion).
 * `bootstrap` gains exactly what `root:bootstrap` and `root:reissue` do in their transaction:
 * - INSERT(id, email_canonical, state) on `app_user`: the pending account (kind stays `iam`,
 *   email_verified false, until the guarded promotion).
 * - SELECT(issuer, enabled) on `oidc_provider`: the issuer must be an enabled provider.
 * - SELECT(user_id), INSERT, DELETE on `oidc_email_enrollment`: pin and replace the (issuer, email).
 */
export class ProductRootEmailBootstrap1792108800019 implements MigrationInterface {
  name = 'ProductRootEmailBootstrap1792108800019';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      GRANT INSERT(id,email_canonical,state) ON public.app_user TO product_bootstrap;
      GRANT SELECT(issuer,enabled) ON public.oidc_provider TO product_bootstrap;
      GRANT SELECT(user_id),INSERT,DELETE ON public.oidc_email_enrollment TO product_bootstrap;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

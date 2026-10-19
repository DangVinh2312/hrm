import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Narrows the login `identity` on `one_time_token` (ADR 0027 step 4), one forward migration.
 * Applies through `migrate` (plain REVOKE; no function of an owner role changes).
 * No runtime code inserts tokens any more: `oidc-activation` is issued only by `root:bootstrap`
 * and `root:reissue` (login `bootstrap`). `identity` keeps SELECT and the `consumed_at` UPDATE.
 */
export class ProductIdentityTokenInsert1792108800020 implements MigrationInterface {
  name = 'ProductIdentityTokenInsert1792108800020';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('REVOKE INSERT ON public.one_time_token FROM product_identity');
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

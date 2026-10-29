import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ProductAuthorization.execute` matches the anchor of a command against the plan and locks it
 * `FOR NO KEY UPDATE`, in the login of the command's mode. The role commands run in `admin` mode
 * (login `authority`), which had no privilege on `role_anchor`. A row lock needs SELECT and UPDATE
 * on at least one column; `singleton` is the one column the table's CHECK keeps constant, so the
 * grant lets the login lock the row and change nothing.
 */
export class RoleAnchorLock1792108800004 implements MigrationInterface {
  name = 'RoleAnchorLock1792108800004';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      GRANT SELECT ON public.role_anchor TO product_authority;
      GRANT UPDATE (singleton) ON public.role_anchor TO product_authority;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error('Role anchor lock requires an explicit restore; automatic downgrade is disabled'),
    );
  }
}

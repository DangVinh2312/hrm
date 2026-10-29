import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `protect_role_rules`: what the authority login may put in `policy_rule`. Only allow rules of
 * roles whose key starts with `custom.`; other logins (owner, sync) are not judged by it.
 * Same-resource pairs of permission and template cannot be checked here (`scope_template` has no
 * resource column), so `checkRoleGrants` stays the guard for that.
 */
export const protectRoleRulesBody = `
      BEGIN
        IF current_user='product_authority' AND (NEW.effect<>'allow'
          OR NEW.role_key IS NULL OR NEW.managed_by<>'runtime'
          OR substring(NEW.role_key FROM 1 FOR 7)<>convert_to('custom.','UTF8')) THEN
          RAISE EXCEPTION 'authority may only write allow rules of runtime roles' USING ERRCODE='42501';
        END IF;
        RETURN NEW;
      END `;

export class RoleRuntimeConstraint1792108800003 implements MigrationInterface {
  name = 'RoleRuntimeConstraint1792108800003';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE public.role_definition ADD CONSTRAINT ck_role_runtime_prefix
        CHECK ((managed_by = 'runtime') = (substring(role_key FROM 1 FOR 7) = convert_to('custom.', 'UTF8')));
      CREATE FUNCTION public.protect_role_rules() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${protectRoleRulesBody}$fn$;
      REVOKE ALL ON FUNCTION public.protect_role_rules() FROM PUBLIC;
      CREATE TRIGGER protect_role_rules BEFORE INSERT OR UPDATE ON public.policy_rule
        FOR EACH ROW EXECUTE FUNCTION public.protect_role_rules();
    `);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Role runtime constraint requires an explicit restore; automatic downgrade is disabled',
      ),
    );
  }
}

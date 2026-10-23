import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Body of `public.reactivate_iam_account` (ADR 0041 §6, ADR 0043): the only way a runtime login
 * leaves `suspended`. It locks one account, refuses anything that is not an IAM account (Root and
 * every other kind: 42501), an absent id (P0002) and an account that is not suspended (55000),
 * then moves it to `active` when an enabled Google binding at an enabled provider exists, and to
 * `pending` otherwise (it waits for its first login). `auth_epoch` always advances, so no session
 * of the earlier life returns. It reads no email and issues no secret, enrollment or token.
 */
export const reactivateIamAccountBody = `
DECLARE
  v_kind text;
  v_state text;
  v_next text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT kind, state INTO v_kind, v_state FROM public.app_user WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_kind IS DISTINCT FROM 'iam' THEN
    RAISE EXCEPTION 'only IAM accounts can be reactivated' USING ERRCODE = '42501';
  END IF;
  IF v_state IS DISTINCT FROM 'suspended' THEN
    RAISE EXCEPTION 'account is not suspended' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT FROM public.external_identity e
      JOIN public.oidc_provider p ON p.issuer = e.issuer AND p.enabled
      WHERE e.user_id = p_user AND e.enabled) THEN
    v_next := 'active';
  ELSE
    v_next := 'pending';
  END IF;
  UPDATE public.app_user SET state = v_next, auth_epoch = auth_epoch + 1 WHERE id = p_user;
END`;

/**
 * Un-suspend of IAM accounts (ADR 0041 wave 1). The definer runs as `product_account_owner`, so
 * `protect_account_lifecycle` (which restricts `product_authority` and `product_identity` by
 * `current_user`) does not apply to it and stays unchanged: the login `authority` still cannot
 * write the transition itself. `guard_root_lifecycle` (session_user) still guards Root rows.
 * Needs the NOLOGIN owner, so it runs through `db:provision` like 013.
 */
export class ProductAccountReactivate1792108800021 implements MigrationInterface {
  name = 'ProductAccountReactivate1792108800021';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      -- Definer rights: exactly what the function reads or updates (probed exactly).
      GRANT SELECT(auth_epoch),UPDATE(state,auth_epoch) ON public.app_user TO product_account_owner;
      GRANT SELECT(issuer,user_id,enabled) ON public.external_identity TO product_account_owner;
      CREATE FUNCTION public.reactivate_iam_account(p_user uuid) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${reactivateIamAccountBody}$fn$;
      REVOKE ALL ON FUNCTION public.reactivate_iam_account(uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.reactivate_iam_account(uuid) TO product_authority;
      ALTER FUNCTION public.reactivate_iam_account(uuid) OWNER TO product_account_owner;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

const emailGrammar = "'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'";

/** `change_iam_account_email`: one UPDATE sets the email, clears its verification and advances `auth_epoch`; the account's old invitation is deleted (it would hold the old email in UNIQUE(issuer, email)) and a pending account gets a new one. Root and absent accounts are refused. */
export const changeIamAccountEmailBody = `
DECLARE
  v_kind text;
  v_state text;
  v_email text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_email IS NULL OR p_issuer IS NULL OR p_actor IS NULL
    OR char_length(p_email) > 254 OR p_email <> lower(p_email)
    OR p_email !~ ${emailGrammar} THEN
    RAISE EXCEPTION 'invalid email change input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT FROM public.oidc_provider WHERE issuer = p_issuer AND enabled) THEN
    RAISE EXCEPTION 'issuer is not an enabled provider' USING ERRCODE = '22023';
  END IF;
  SELECT kind, state, email_canonical INTO v_kind, v_state, v_email
    FROM public.app_user WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_kind IS DISTINCT FROM 'iam' THEN
    RAISE EXCEPTION 'only IAM accounts can change email' USING ERRCODE = '42501';
  END IF;
  IF v_email IS NOT DISTINCT FROM p_email THEN
    RAISE EXCEPTION 'email is unchanged' USING ERRCODE = '55000';
  END IF;
  UPDATE public.app_user
    SET email_canonical = p_email, email_verified = false, auth_epoch = auth_epoch + 1
    WHERE id = p_user;
  DELETE FROM public.oidc_email_enrollment WHERE user_id = p_user;
  IF v_state = 'pending' THEN
    INSERT INTO public.oidc_email_enrollment(user_id, issuer, email_canonical, expires_at, created_by)
      VALUES (p_user, p_issuer, p_email, statement_timestamp() + interval '7 days', p_actor);
  END IF;
END`;

/** `reset_iam_mfa`: deletes the recovery codes, then the factor, and advances `auth_epoch` itself because `mfa_epoch` ignores an unconfirmed factor. */
export const resetIamMfaBody = `
DECLARE
  v_kind text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT kind INTO v_kind FROM public.app_user WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_kind IS DISTINCT FROM 'iam' THEN
    RAISE EXCEPTION 'only IAM accounts can reset the second factor' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT FROM public.mfa_totp WHERE user_id = p_user)
    AND NOT EXISTS (SELECT FROM public.mfa_recovery_code WHERE user_id = p_user) THEN
    RAISE EXCEPTION 'no second factor to reset' USING ERRCODE = '55000';
  END IF;
  DELETE FROM public.mfa_recovery_code WHERE user_id = p_user;
  DELETE FROM public.mfa_totp WHERE user_id = p_user;
  UPDATE public.app_user SET auth_epoch = auth_epoch + 1 WHERE id = p_user;
END`;

/** `reset_iam_google_binding`: disables (never deletes) the enabled binding, replaces the invitation for the current email, moves `active` to `pending` and advances `auth_epoch`; `suspended` stays suspended. */
export const resetIamGoogleBindingBody = `
DECLARE
  v_kind text;
  v_email text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_issuer IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'invalid binding reset input' USING ERRCODE = '22023';
  END IF;
  SELECT kind, email_canonical INTO v_kind, v_email
    FROM public.app_user WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_kind IS DISTINCT FROM 'iam' THEN
    RAISE EXCEPTION 'only IAM accounts can reset the Google binding' USING ERRCODE = '42501';
  END IF;
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'account has no email to invite' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT FROM public.oidc_provider WHERE issuer = p_issuer AND enabled) THEN
    RAISE EXCEPTION 'issuer is not an enabled provider' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.oidc_email_enrollment WHERE user_id = p_user;
  INSERT INTO public.oidc_email_enrollment(user_id, issuer, email_canonical, expires_at, created_by)
    VALUES (p_user, p_issuer, v_email, statement_timestamp() + interval '7 days', p_actor);
  UPDATE public.external_identity SET enabled = false, binding_version = binding_version + 1
    WHERE user_id = p_user AND enabled;
  UPDATE public.app_user
    SET state = CASE WHEN state = 'active' THEN 'pending' ELSE state END, auth_epoch = auth_epoch + 1
    WHERE id = p_user;
END`;

/**
 * Three SECURITY DEFINER functions, each with its own NOLOGIN owner and the column-exact
 * rights it needs (`emailOwnerAcl`, `mfaOwnerAcl`, `bindingOwnerAcl` in the privilege
 * declarations), executable by the authority login only. The owner change needs the migration
 * login's temporary membership, which only `provisionProductDatabase` grants.
 */
export class IdentityOperations1792108800005 implements MigrationInterface {
  name = 'IdentityOperations1792108800005';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      GRANT SELECT(id,kind,state,email_canonical,auth_epoch),UPDATE(email_canonical,email_verified,auth_epoch) ON public.app_user TO product_email_owner;
      GRANT SELECT(issuer,enabled) ON public.oidc_provider TO product_email_owner;
      GRANT SELECT(user_id),INSERT,DELETE ON public.oidc_email_enrollment TO product_email_owner;
      CREATE FUNCTION public.change_iam_account_email(p_user uuid, p_email text, p_issuer text, p_actor uuid) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${changeIamAccountEmailBody}$fn$;
      REVOKE ALL ON FUNCTION public.change_iam_account_email(uuid,text,text,uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.change_iam_account_email(uuid,text,text,uuid) TO product_authority;
      ALTER FUNCTION public.change_iam_account_email(uuid,text,text,uuid) OWNER TO product_email_owner;

      GRANT SELECT(id,kind,auth_epoch),UPDATE(auth_epoch) ON public.app_user TO product_mfa_owner;
      GRANT SELECT(user_id),DELETE ON public.mfa_totp,public.mfa_recovery_code TO product_mfa_owner;
      CREATE FUNCTION public.reset_iam_mfa(p_user uuid) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${resetIamMfaBody}$fn$;
      REVOKE ALL ON FUNCTION public.reset_iam_mfa(uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.reset_iam_mfa(uuid) TO product_authority;
      ALTER FUNCTION public.reset_iam_mfa(uuid) OWNER TO product_mfa_owner;

      GRANT SELECT(id,kind,state,email_canonical,auth_epoch),UPDATE(state,auth_epoch) ON public.app_user TO product_binding_owner;
      GRANT SELECT(user_id,enabled,binding_version),UPDATE(enabled,binding_version) ON public.external_identity TO product_binding_owner;
      GRANT SELECT(issuer,enabled) ON public.oidc_provider TO product_binding_owner;
      GRANT SELECT(user_id),INSERT,DELETE ON public.oidc_email_enrollment TO product_binding_owner;
      CREATE FUNCTION public.reset_iam_google_binding(p_user uuid, p_issuer text, p_actor uuid) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${resetIamGoogleBindingBody}$fn$;
      REVOKE ALL ON FUNCTION public.reset_iam_google_binding(uuid,text,uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.reset_iam_google_binding(uuid,text,uuid) TO product_authority;
      ALTER FUNCTION public.reset_iam_google_binding(uuid,text,uuid) OWNER TO product_binding_owner;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error('Identity operations require an explicit restore; automatic downgrade is disabled'),
    );
  }
}

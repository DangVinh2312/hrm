import type { MigrationInterface, QueryRunner } from 'typeorm';

const emailGrammar = "'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'";

/** Printable ASCII, `!` to `~`; bracket ranges of PostgreSQL regular expressions are code points. */
const asciiEmail = "'^[!-~]+$'";

/** `provision_oidc_account` with the email limited to printable ASCII, checked before `lower`. */
export const provisionOidcAccountAsciiBody = `
BEGIN
  IF p_user IS NULL OR p_actor IS NULL OR p_email IS NULL OR p_issuer IS NULL
    OR char_length(p_email) > 254 OR p_email !~ ${asciiEmail} OR p_email <> lower(p_email)
    OR p_email !~ ${emailGrammar} THEN
    RAISE EXCEPTION 'invalid account provisioning input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT FROM public.oidc_provider WHERE issuer = p_issuer AND enabled) THEN
    RAISE EXCEPTION 'issuer is not an enabled provider' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.app_user(id, email_canonical, state) VALUES (p_user, p_email, 'pending');
  INSERT INTO public.oidc_email_enrollment(user_id, issuer, email_canonical, expires_at, created_by)
    VALUES (p_user, p_issuer, p_email, statement_timestamp() + interval '7 days', p_actor);
END`;

/** `change_iam_account_email` with the email limited to printable ASCII, checked before `lower`. */
export const changeIamAccountEmailAsciiBody = `
DECLARE
  v_kind text;
  v_state text;
  v_email text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_email IS NULL OR p_issuer IS NULL OR p_actor IS NULL
    OR char_length(p_email) > 254 OR p_email !~ ${asciiEmail} OR p_email <> lower(p_email)
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

/**
 * Sign-in emails are printable ASCII only: both definers that take an email and both
 * columns that hold one. A stored email outside it makes the constraint fail (23514) and nothing
 * changes; it is corrected by hand, never here. The definer bodies are replaced by their owners,
 * so this needs the migration login's temporary membership that only provisioning grants.
 */
export class AsciiLoginEmail1792108800008 implements MigrationInterface {
  name = 'AsciiLoginEmail1792108800008';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE public.app_user ADD CONSTRAINT ck_app_user_email_ascii
        CHECK (email_canonical ~ ${asciiEmail});
      ALTER TABLE public.oidc_email_enrollment ADD CONSTRAINT ck_oidc_email_enrollment_ascii
        CHECK (email_canonical ~ ${asciiEmail});
      SET LOCAL ROLE product_account_owner;
      CREATE OR REPLACE FUNCTION public.provision_oidc_account(p_user uuid, p_email text, p_issuer text, p_actor uuid) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${provisionOidcAccountAsciiBody}$fn$;
      SET LOCAL ROLE product_email_owner;
      CREATE OR REPLACE FUNCTION public.change_iam_account_email(p_user uuid, p_email text, p_issuer text, p_actor uuid) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${changeIamAccountEmailAsciiBody}$fn$;
      RESET ROLE;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error('ASCII login email requires an explicit restore; automatic downgrade is disabled'),
    );
  }
}

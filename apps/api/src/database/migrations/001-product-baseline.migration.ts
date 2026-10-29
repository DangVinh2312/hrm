import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Product baseline (ADR 0048): the identity and authority schema in its final shape, replacing the
 * forward migrations 001-021 of the single-product transition. It runs on an empty database only
 * (tables are created, never altered) and through `db:provision`, because it hands functions to the
 * NOLOGIN owner roles (temporary owner membership of the migration login). From this baseline on,
 * a migration that was applied is not edited; schema changes are new forward migrations.
 */

/** Bounded byte key, the PostgreSQL mapping of VARBINARY(n) in spec section 6. */
const key = (column: string, max: number, nullable = false) =>
  `${column} bytea ${nullable ? '' : 'NOT NULL '}CONSTRAINT ck_${column}_length CHECK (octet_length(${column}) BETWEEN 1 AND ${max})`;

const hash = (column: string) =>
  `${column} bytea NOT NULL CONSTRAINT ck_${column}_length CHECK (octet_length(${column}) = 32)`;

const lifecycle = `lifecycle varchar(16) NOT NULL CONSTRAINT ck_lifecycle CHECK (lifecycle IN ('active', 'deprecated', 'retired'))`;
const keyKind = `key_kind varchar(16) NOT NULL CONSTRAINT ck_key_kind CHECK (key_kind IN ('integer', 'uuid', 'string'))`;
const managedBy = `managed_by varchar(16) NOT NULL CONSTRAINT ck_managed_by CHECK (managed_by IN ('code', 'runtime'))`;

const oneSubject = `CONSTRAINT ck_one_subject CHECK ((user_id IS NOT NULL AND role_key IS NULL) OR (user_id IS NULL AND role_key IS NOT NULL))`;

/** Exact bodies of the protection functions; the startup probe (`product-privilege.declarations.ts`) compares them, so a neutralized replacement fails closed. */
export const sharedFenceBody = `
        DECLARE v_revision bigint; v_required integer;
        BEGIN
          SELECT revision,min_runtime_capability INTO v_revision,v_required FROM public.authz_state WHERE singleton FOR SHARE;
          IF NOT FOUND THEN RAISE EXCEPTION 'application fence missing' USING ERRCODE='P0002'; END IF;
          IF v_required>p_capability THEN RAISE EXCEPTION 'runtime incompatible' USING ERRCODE='AZ001'; END IF;
          RETURN v_revision;
        END `;

/** `resolve_session`: OIDC sessions only (ADR 0027 §2); returns `kind` (ADR 0012). */
export const resolveSessionOidcBody = `
        SELECT u.id,u.kind,u.state,u.auth_epoch,s.method,s.assurance,s.authenticated_at,s.reauthenticated_at,s.expires_at
        FROM public.application_session s JOIN public.app_user u ON u.id=s.user_id
        JOIN public.external_identity e ON e.issuer=s.external_issuer AND e.subject=s.external_subject AND e.user_id=u.id
        WHERE s.token_hash=p_digest AND u.state='active' AND s.auth_epoch=u.auth_epoch
          AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND s.last_seen_at>statement_timestamp()-interval '30 minutes'
          AND s.method='oidc' AND e.enabled AND e.binding_version=s.binding_version
          AND EXISTS (SELECT FROM public.oidc_provider p WHERE p.issuer=e.issuer AND p.enabled AND p.version=s.provider_version)
        `;

export const productStateBody = `
      BEGIN
        IF TG_TABLE_NAME='security_bootstrap_state' THEN
          IF OLD.initialized_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'bootstrap marker is permanent' USING ERRCODE='42501';
          END IF;
        ELSIF NEW.revision<OLD.revision OR NEW.release_sequence<OLD.release_sequence OR NEW.min_runtime_capability<OLD.min_runtime_capability THEN
          RAISE EXCEPTION 'application authority state cannot downgrade' USING ERRCODE='42501';
        END IF;
        RETURN NEW;
      END `;

/** `protect_product_rows`: code-owned facts and system role references; IAM has no rank and no `user_role` branch (ADR 0012). */
export const productRowsIamBody = `
      DECLARE old_code boolean:=false; new_code boolean:=false; old_role bytea; new_role bytea;
      BEGIN
        IF TG_TABLE_NAME IN ('role_definition','policy_rule') THEN
          IF TG_OP<>'INSERT' THEN old_code:=OLD.managed_by='code'; END IF;
          IF TG_OP<>'DELETE' THEN new_code:=NEW.managed_by='code'; END IF;
        ELSIF TG_TABLE_NAME IN ('relation_edge','user_boundary') THEN
          IF TG_OP<>'INSERT' THEN old_code:=OLD.seed_owner IS NOT NULL; END IF;
          IF TG_OP<>'DELETE' THEN new_code:=NEW.seed_owner IS NOT NULL; END IF;
        END IF;
        IF current_user='product_sync' THEN
          IF (TG_OP<>'INSERT' AND NOT old_code) OR (TG_OP<>'DELETE' AND NOT new_code) THEN
            RAISE EXCEPTION 'sync cannot take over runtime facts' USING ERRCODE='42501';
          END IF;
        ELSIF old_code OR new_code THEN
          RAISE EXCEPTION 'code owned facts protected' USING ERRCODE='42501';
        END IF;
        IF TG_TABLE_NAME IN ('policy_rule','record_exception')
          AND NOT (TG_TABLE_NAME='policy_rule' AND current_user='product_sync') THEN
          IF TG_OP<>'INSERT' THEN old_role:=OLD.role_key; END IF;
          IF TG_OP<>'DELETE' THEN new_role:=NEW.role_key; END IF;
          IF EXISTS(SELECT FROM public.role_definition WHERE role_key IN (old_role,new_role) AND managed_by='code') THEN
            RAISE EXCEPTION 'system role references protected' USING ERRCODE='42501';
          END IF;
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
      END `;

/** `protect_account_lifecycle`: identity may only activate pending accounts, authority may only suspend (judged by `current_user`). */
export const accountLifecycleBody = `
      BEGIN
        IF current_user='product_identity' AND NEW.state IS DISTINCT FROM OLD.state
          AND NOT (OLD.state='pending' AND NEW.state='active') THEN
          RAISE EXCEPTION 'identity may only activate pending accounts' USING ERRCODE='42501';
        ELSIF current_user='product_authority' AND NEW.state IS DISTINCT FROM OLD.state
          AND NEW.state<>'suspended' THEN
          RAISE EXCEPTION 'authority may only suspend accounts' USING ERRCODE='42501';
        END IF;
        RETURN NEW;
      END `;

export const tokenConsumptionBody = `
BEGIN
  IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS DISTINCT FROM statement_timestamp()
    OR (NEW.token_hash,NEW.user_id,NEW.purpose,NEW.expires_at,NEW.credential_version)
       IS DISTINCT FROM (OLD.token_hash,OLD.user_id,OLD.purpose,OLD.expires_at,OLD.credential_version) THEN
    RAISE EXCEPTION 'one-time tokens may only be consumed' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/** `guard_root_kind`: iam to root once, by the offline bootstrap login under READ COMMITTED (ADR 0012, OIDC activation only). */
export const guardRootKindOidcBody = `
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.kind='root' THEN
      RAISE EXCEPTION 'Root accounts are created only by promotion' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind IS NOT DISTINCT FROM OLD.kind THEN RETURN NEW; END IF;
  IF NOT (OLD.kind='iam' AND NEW.kind='root') THEN
    RAISE EXCEPTION 'account kind is immutable except the one Root promotion' USING ERRCODE='42501';
  END IF;
  IF session_user<>'product_bootstrap' THEN
    RAISE EXCEPTION 'Root promotion is offline bootstrap only' USING ERRCODE='42501';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Root promotion requires READ COMMITTED' USING ERRCODE='42501';
  END IF;
  IF OLD.state<>'pending' THEN
    RAISE EXCEPTION 'Root promotion target must be pending' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT FROM public.security_bootstrap_state WHERE singleton AND initialized_at IS NOT NULL)
    OR EXISTS(SELECT FROM public.app_user WHERE kind='root') THEN
    RAISE EXCEPTION 'Root promotion is one-time' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT FROM public.user_role WHERE user_id=NEW.id)
    OR EXISTS(SELECT FROM public.user_boundary WHERE user_id=NEW.id)
    OR EXISTS(SELECT FROM public.policy_rule WHERE user_id=NEW.id)
    OR EXISTS(SELECT FROM public.record_exception WHERE user_id=NEW.id) THEN
    RAISE EXCEPTION 'Root promotion target holds IAM facts' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT FROM public.one_time_token WHERE user_id=NEW.id AND purpose='oidc-activation'
      AND consumed_at IS NULL AND expires_at>statement_timestamp()) THEN
    RAISE EXCEPTION 'Root promotion target holds a live activation token' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/** Deferred: a promotion commits only with the marker naming that account. */
export const requireRootMarkerKindBody = `
BEGIN
  IF NEW.kind='root' AND OLD.kind IS DISTINCT FROM 'root' THEN
    IF NOT EXISTS(SELECT FROM public.security_bootstrap_state
        WHERE singleton AND initialized_at IS NOT NULL AND target_user_id=NEW.id) THEN
      RAISE EXCEPTION 'Root promotion requires the bootstrap marker naming it' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NULL;
END`;

/** FOR SHARE conflicts with the promotion FOR NO KEY UPDATE (spec 3.3); FK KEY SHARE does not. */
export const guardRootNotIamSubjectBody = `
DECLARE v_kind text;
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT kind INTO v_kind FROM public.app_user WHERE id=NEW.user_id FOR SHARE;
  IF v_kind='root' THEN
    RAISE EXCEPTION 'Root is outside IAM: no role, boundary, rule or exception' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/** `guard_root_activation`: an activation token for Root is issued by the bootstrap credential only. */
export const guardRootActivationOidcBody = `
DECLARE v_kind text;
BEGIN
  IF NEW.purpose='oidc-activation' THEN
    SELECT kind INTO v_kind FROM public.app_user WHERE id=NEW.user_id FOR SHARE;
    IF v_kind='root' AND session_user<>'product_bootstrap' THEN
      RAISE EXCEPTION 'Root activation is issued by the bootstrap credential only' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END`;

/** `guard_root_lifecycle` (ADR 0023 §4, ADR 0026 §4, §10): OLD.kind decides; bootstrap may suspend Root, give it a new unverified email, or end its sessions once it holds no second factor. */
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

/** `provision_oidc_account` (ADR 0020 §3): creates a pending IAM account with its canonical email and a 7-day enrollment at an enabled provider; never changes an existing account, binds a subject or grants anything. A duplicate email is the unique violation 23505 the caller maps to 409. */
export const provisionOidcAccountBody = `
BEGIN
  IF p_user IS NULL OR p_actor IS NULL OR p_email IS NULL OR p_issuer IS NULL
    OR char_length(p_email) > 254 OR p_email <> lower(p_email)
    OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
    RAISE EXCEPTION 'invalid account provisioning input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT FROM public.oidc_provider WHERE issuer = p_issuer AND enabled) THEN
    RAISE EXCEPTION 'issuer is not an enabled provider' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.app_user(id, email_canonical, state) VALUES (p_user, p_email, 'pending');
  INSERT INTO public.oidc_email_enrollment(user_id, issuer, email_canonical, expires_at, created_by)
    VALUES (p_user, p_issuer, p_email, statement_timestamp() + interval '7 days', p_actor);
END`;

/** `reactivate_iam_account` (ADR 0041 §6, ADR 0043): the only way a runtime login leaves `suspended`; IAM accounts only, `auth_epoch` always advances, no email read and no secret issued. */
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

/** `protect_binding_ref` (ADR 0023 §2): the reference a client names a binding by never changes, for any login. */
export const protectBindingRefBody = `
BEGIN
  IF NEW.binding_ref IS DISTINCT FROM OLD.binding_ref THEN
    RAISE EXCEPTION 'binding reference is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/** `require_email_epoch` (ADR 0023 §4): an email change must advance `auth_epoch` in the same row update, for every login. */
export const requireEmailEpochBody = `
BEGIN
  IF (NEW.email_canonical IS DISTINCT FROM OLD.email_canonical
      OR NEW.email_verified IS DISTINCT FROM OLD.email_verified)
    AND NEW.auth_epoch <= OLD.auth_epoch THEN
    RAISE EXCEPTION 'an email change must end the account sessions' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

/** `protect_mfa_totp` (ADR 0026 §4): a factor starts unconfirmed, confirmation is permanent, removal is a DELETE; bootstrap may only delete the Root factor. */
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

/** `protect_mfa_recovery_code` (ADR 0026 §4): codes start unused and an UPDATE only marks one used now. */
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

/** `mfa_epoch` (ADR 0026 §4, §6): confirming or removing a second factor, and each failed verify from the tenth on, ends every session of the account in the same statement. */
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
 * Projection of IAM accounts for `account.read`/`account.suspend` (ADR 0020 §4): email, state and the
 * enrollment status only. Owner rights (not security_invoker) so runtime logins read these columns
 * through the view and never `app_user.email_canonical`; `security_barrier` keeps a caller's
 * predicate from seeing Root rows before `kind = 'iam'` filters them.
 */
const accountDirectoryView = `SELECT u.id, u.email_canonical AS email, u.state, CASE WHEN e.user_id IS NULL THEN NULL WHEN e.expires_at > statement_timestamp() THEN 'pending' ELSE 'expired' END AS enrollment FROM public.app_user u LEFT JOIN public.oidc_email_enrollment e ON e.user_id = u.id WHERE u.kind = 'iam'`;

const protectedRowTables = [
  'role_definition',
  'policy_rule',
  'record_exception',
  'user_role',
  'relation_edge',
  'user_boundary',
] as const;
const iamTables = ['user_role', 'user_boundary', 'policy_rule', 'record_exception'] as const;
const rootGuards = [
  ['guard_root_kind', guardRootKindOidcBody],
  ['require_root_marker_kind', requireRootMarkerKindBody],
  ['guard_root_not_iam_subject', guardRootNotIamSubjectBody],
  ['guard_root_activation', guardRootActivationOidcBody],
  ['guard_root_lifecycle', guardRootLifecycleMfaBody],
] as const;

export class ProductBaseline1792108800001 implements MigrationInterface {
  name = 'ProductBaseline1792108800001';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`

      CREATE TABLE authz_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
        manifest_hash bytea NOT NULL DEFAULT decode(repeat('00',32),'hex') CHECK (octet_length(manifest_hash)=32),
        release_sequence bigint NOT NULL DEFAULT 0 CHECK (release_sequence>=0),
        materialized_hash bytea CHECK(materialized_hash IS NULL OR octet_length(materialized_hash)=32),
        min_runtime_capability smallint NOT NULL DEFAULT 1 CHECK (min_runtime_capability>=0)
      );
      INSERT INTO authz_state(singleton) VALUES(true);
      CREATE TABLE app_user (
        id uuid PRIMARY KEY,
        email_canonical text UNIQUE,
        email_verified boolean NOT NULL DEFAULT false,
        state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','suspended')),
        auth_epoch bigint NOT NULL DEFAULT 1 CHECK(auth_epoch>0),
        kind text NOT NULL DEFAULT 'iam' CONSTRAINT ck_app_user_kind CHECK (kind IN ('root','iam'))
      );
      CREATE UNIQUE INDEX ux_app_user_root ON app_user ((true)) WHERE kind='root';
      CREATE TABLE external_identity (
        issuer text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL REFERENCES app_user(id),
        binding_version bigint NOT NULL DEFAULT 1 CHECK(binding_version>0), enabled boolean NOT NULL DEFAULT true,
        binding_ref uuid NOT NULL DEFAULT gen_random_uuid(),
        PRIMARY KEY(issuer,subject),
        CONSTRAINT uq_external_identity_binding_ref UNIQUE (binding_ref)
      );
      CREATE INDEX ix_external_user ON external_identity(user_id);
      CREATE UNIQUE INDEX uq_external_identity_one_enabled ON external_identity(user_id) WHERE enabled;
      CREATE TABLE application_session (
        token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32), user_id uuid NOT NULL REFERENCES app_user(id),
        auth_epoch bigint NOT NULL, method text NOT NULL CONSTRAINT application_session_method_check CHECK(method='oidc'),
        assurance text NOT NULL, external_issuer text NOT NULL, external_subject text NOT NULL, binding_version bigint NOT NULL, provider_version bigint NOT NULL,
        last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(), reauthenticated_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(), authenticated_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL, revoked_at timestamptz,
        CHECK(expires_at>created_at)
      );
      CREATE INDEX ix_session_user ON application_session(user_id);
      CREATE INDEX ix_session_expiry ON application_session(expires_at);
      CREATE TABLE one_time_token (
        token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32), user_id uuid NOT NULL REFERENCES app_user(id),
        purpose text NOT NULL CHECK(purpose='oidc-activation'), expires_at timestamptz NOT NULL,
        consumed_at timestamptz, credential_version bigint
      );
      CREATE INDEX ix_token_user ON one_time_token(user_id);
      CREATE TABLE oidc_login_attempt (
        state_hash bytea PRIMARY KEY CHECK(octet_length(state_hash)=32), nonce text NOT NULL,
        browser_hash bytea NOT NULL, verifier text NOT NULL, provider_issuer text NOT NULL,
        provider_version bigint NOT NULL, redirect_uri text NOT NULL,
        purpose text NOT NULL DEFAULT 'login' CHECK(purpose IN ('login','activation')), enrollment_hash bytea, linking_user_id uuid REFERENCES app_user(id),
        expires_at timestamptz NOT NULL, consumed_at timestamptz
      );
      CREATE TABLE oidc_provider (issuer text PRIMARY KEY, version bigint NOT NULL CHECK(version>0), enabled boolean NOT NULL);
      CREATE TABLE rate_limit (bucket_key bytea PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL CHECK(attempts>=0));
      CREATE TABLE security_bootstrap_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), operation_id uuid UNIQUE,
        target_user_id uuid REFERENCES app_user(id), initialized_at timestamptz,
        CHECK((operation_id IS NULL AND target_user_id IS NULL AND initialized_at IS NULL) OR
          (operation_id IS NOT NULL AND target_user_id IS NOT NULL AND initialized_at IS NOT NULL))
      );
      INSERT INTO security_bootstrap_state(singleton) VALUES(true);

      CREATE TABLE resource_type (
        
        ${key('type_key', 96)},
        ${keyKind},
        ${key('binding_key', 128)},
        PRIMARY KEY (type_key)
      );

      CREATE TABLE permission_policy (
        
        ${key('policy_key', 128)},
        policy_version integer NOT NULL CONSTRAINT ck_policy_version CHECK (policy_version > 0),
        ${hash('definition_hash')},
        definition jsonb NOT NULL,
        ${lifecycle},
        PRIMARY KEY (policy_key, policy_version)
      );

      CREATE TABLE permission_catalog (
        
        ${key('permission_key', 160)},
        ${key('type_key', 96)},
        ${key('action_key', 64)},
        ${key('policy_key', 128)},
        policy_version integer NOT NULL,
        ${lifecycle},
        boundary_requirement text NOT NULL CHECK(boundary_requirement IN ('required','optional')),
        PRIMARY KEY (permission_key),
        CONSTRAINT uq_permission_action UNIQUE (type_key, action_key),
        CONSTRAINT uq_permission_type UNIQUE (permission_key, type_key),
        CONSTRAINT fk_permission_type FOREIGN KEY (type_key)
          REFERENCES resource_type (type_key),
        CONSTRAINT fk_permission_policy FOREIGN KEY (policy_key, policy_version)
          REFERENCES permission_policy (policy_key, policy_version)
      );
      CREATE INDEX ix_permission_policy ON permission_catalog (policy_key, policy_version);

      CREATE TABLE scope_template (
        
        ${key('template_key', 128)},
        version integer NOT NULL CONSTRAINT ck_template_version CHECK (version > 0),
        ${hash('definition_hash')},
        PRIMARY KEY (template_key, version)
      );

      CREATE TABLE role_definition (
        
        ${key('role_key', 96)},
        ${managedBy},
        label varchar(120) NOT NULL,
        PRIMARY KEY (role_key)
      );

      CREATE TABLE user_role (
        
        user_id uuid NOT NULL,
        ${key('role_key', 96)},
        PRIMARY KEY (user_id, role_key),
        CONSTRAINT fk_user_role_membership FOREIGN KEY (user_id)
          REFERENCES app_user (id),
        CONSTRAINT fk_user_role_role FOREIGN KEY (role_key)
          REFERENCES role_definition (role_key)
      );
      CREATE INDEX ix_role_members ON user_role (role_key, user_id);

      CREATE TABLE policy_rule (
        
        rule_id uuid NOT NULL,
        ${key('permission_key', 160)},
        user_id uuid,
        ${key('role_key', 96, true)},
        effect varchar(8) NOT NULL CONSTRAINT ck_effect CHECK (effect IN ('allow', 'deny')),
        ${key('template_key', 128)},
        template_version integer NOT NULL,
        parameters jsonb NOT NULL,
        ${managedBy},
        system_owner bytea, system_key bytea,
        UNIQUE(system_owner, system_key),
        CHECK((system_owner IS NULL)=(system_key IS NULL)),
        CHECK(system_owner IS NULL OR managed_by='code'),

        PRIMARY KEY (rule_id),
        ${oneSubject},
        CONSTRAINT fk_rule_permission FOREIGN KEY (permission_key)
          REFERENCES permission_catalog (permission_key),
        CONSTRAINT fk_rule_membership FOREIGN KEY (user_id)
          REFERENCES app_user (id),
        CONSTRAINT fk_rule_role FOREIGN KEY (role_key)
          REFERENCES role_definition (role_key),
        CONSTRAINT fk_rule_template FOREIGN KEY (template_key, template_version)
          REFERENCES scope_template (template_key, version)
      );
      CREATE INDEX ix_rule_identity ON policy_rule (permission_key, user_id, effect);
      CREATE INDEX ix_rule_role ON policy_rule (permission_key, role_key, effect);
      CREATE INDEX ix_rule_membership ON policy_rule (user_id);
      CREATE INDEX ix_rule_role_definition ON policy_rule (role_key);
      CREATE INDEX ix_rule_template ON policy_rule (template_key, template_version);

      CREATE TABLE object_ref (
        
        object_id uuid NOT NULL,
        ${key('type_key', 96)},
        ${keyKind},
        ${key('key_bytes', 256)},
        PRIMARY KEY (object_id),
        CONSTRAINT uq_object_key UNIQUE (type_key, key_kind, key_bytes),
        CONSTRAINT uq_object_type UNIQUE (object_id, type_key),
        CONSTRAINT fk_object_type FOREIGN KEY (type_key)
          REFERENCES resource_type (type_key)
      );

      CREATE TABLE record_exception (
        
        exception_id uuid NOT NULL,
        object_id uuid NOT NULL,
        ${key('type_key', 96)},
        ${key('permission_key', 160)},
        user_id uuid,
        ${key('role_key', 96, true)},
        effect varchar(8) NOT NULL CONSTRAINT ck_effect CHECK (effect IN ('allow', 'deny')),
        purpose varchar(16) NOT NULL CONSTRAINT ck_exception_purpose CHECK (purpose IN ('manual', 'emergency')),
        starts_at timestamptz(6) NOT NULL,
        expires_at timestamptz(6),
        reason varchar(1000) NOT NULL CONSTRAINT ck_exception_reason CHECK (char_length(btrim(reason)) > 0),
        issued_by uuid NOT NULL,
        revoked_at timestamptz(6),
        PRIMARY KEY (exception_id),
        ${oneSubject},
        CONSTRAINT ck_exception_interval CHECK (expires_at IS NULL OR expires_at > starts_at),
        CONSTRAINT ck_exception_emergency CHECK (
          purpose <> 'emergency' OR (expires_at IS NOT NULL AND effect = 'allow' AND user_id IS NOT NULL)
        ),
        CONSTRAINT fk_exception_object FOREIGN KEY (object_id, type_key)
          REFERENCES object_ref (object_id, type_key) ON DELETE CASCADE,
        CONSTRAINT fk_exception_permission FOREIGN KEY (permission_key, type_key)
          REFERENCES permission_catalog (permission_key, type_key),
        CONSTRAINT fk_exception_membership FOREIGN KEY (user_id)
          REFERENCES app_user (id),
        CONSTRAINT fk_exception_role FOREIGN KEY (role_key)
          REFERENCES role_definition (role_key),
        CONSTRAINT fk_exception_issuer FOREIGN KEY (issued_by)
          REFERENCES app_user (id)
      );
      CREATE INDEX ix_exception_identity ON record_exception (permission_key, user_id, object_id);
      CREATE INDEX ix_exception_role ON record_exception (permission_key, role_key, object_id);
      CREATE INDEX ix_exception_expiry ON record_exception (expires_at);
      CREATE INDEX ix_exception_object ON record_exception (object_id, type_key);
      CREATE INDEX ix_exception_permission ON record_exception (permission_key, type_key);
      CREATE INDEX ix_exception_membership ON record_exception (user_id);
      CREATE INDEX ix_exception_role_definition ON record_exception (role_key);
      CREATE INDEX ix_exception_issuer ON record_exception (issued_by);

      CREATE TABLE resource_relation_definition (
        
        ${key('relation_key', 96)},
        relation_version integer NOT NULL CONSTRAINT ck_relation_version CHECK (relation_version > 0),
        ${key('source_type', 96)},
        ${key('target_type', 96)},
        binding_kind varchar(16) NOT NULL CONSTRAINT ck_binding_kind CHECK (binding_kind IN ('edgeStore', 'domain')),
        ${key('binding_key', 128)},
        ${hash('definition_hash')},
        ${lifecycle},
        PRIMARY KEY (relation_key, relation_version),
        CONSTRAINT uq_relation_types UNIQUE (relation_key, relation_version, source_type, target_type),
        CONSTRAINT fk_relation_source_type FOREIGN KEY (source_type)
          REFERENCES resource_type (type_key),
        CONSTRAINT fk_relation_target_type FOREIGN KEY (target_type)
          REFERENCES resource_type (type_key)
      );
      CREATE INDEX ix_relation_source_type ON resource_relation_definition (source_type);
      CREATE INDEX ix_relation_target_type ON resource_relation_definition (target_type);

      CREATE TABLE relation_edge (
        
        ${key('relation_key', 96)},
        relation_version integer NOT NULL,
        source_object uuid NOT NULL,
        ${key('source_type', 96)},
        target_object uuid NOT NULL,
        ${key('target_type', 96)},
        starts_at timestamptz(6) NOT NULL,
        expires_at timestamptz(6),
        ${key('seed_owner', 128, true)},
        ${key('seed_key', 128, true)},
        PRIMARY KEY (relation_key, relation_version, source_object, target_object),
        CONSTRAINT uq_relation_seed UNIQUE (seed_owner, seed_key),
        CONSTRAINT ck_edge_interval CHECK (expires_at IS NULL OR expires_at > starts_at),
        CONSTRAINT ck_edge_seed CHECK ((seed_owner IS NULL) = (seed_key IS NULL)),
        CONSTRAINT fk_edge_definition FOREIGN KEY (relation_key, relation_version, source_type, target_type)
          REFERENCES resource_relation_definition (relation_key, relation_version, source_type, target_type),
        CONSTRAINT fk_edge_source FOREIGN KEY (source_object, source_type)
          REFERENCES object_ref (object_id, type_key) ON DELETE CASCADE,
        CONSTRAINT fk_edge_target FOREIGN KEY (target_object, target_type)
          REFERENCES object_ref (object_id, type_key) ON DELETE CASCADE
      );
      CREATE INDEX ix_edge_target ON relation_edge (relation_key, relation_version, target_object, source_object);
      CREATE INDEX ix_edge_source_object ON relation_edge (source_object, source_type);
      CREATE INDEX ix_edge_target_object ON relation_edge (target_object, target_type);

      CREATE TABLE user_relation (
        
        ${key('relation_key', 96)},
        object_id uuid NOT NULL,
        user_id uuid NOT NULL,
        starts_at timestamptz(6) NOT NULL,
        expires_at timestamptz(6),
        relation_version integer NOT NULL CHECK(relation_version>0),
        PRIMARY KEY (relation_key, relation_version, object_id, user_id),
        CONSTRAINT ck_user_relation_interval CHECK (expires_at IS NULL OR expires_at > starts_at),
        CONSTRAINT fk_user_relation_object FOREIGN KEY (object_id)
          REFERENCES object_ref (object_id) ON DELETE CASCADE,
        CONSTRAINT fk_user_relation_membership FOREIGN KEY (user_id)
          REFERENCES app_user (id)
      );
      CREATE INDEX ix_user_relation ON user_relation (relation_key, user_id, object_id);
      CREATE INDEX ix_user_relation_object ON user_relation (object_id);
      CREATE INDEX ix_user_relation_membership ON user_relation (user_id);
      CREATE INDEX ix_user_relation_version ON user_relation(relation_key,relation_version,user_id,object_id);

      CREATE TABLE permission_boundary (
        
        ${key('boundary_key', 128)},
        boundary_version integer NOT NULL CONSTRAINT ck_boundary_version CHECK (boundary_version > 0),
        definition_hash bytea NOT NULL CONSTRAINT ck_definition_hash_length CHECK (octet_length(definition_hash) = 32),
        definition jsonb NOT NULL,
        lifecycle varchar(16) NOT NULL CONSTRAINT ck_lifecycle CHECK (lifecycle IN ('active', 'deprecated', 'retired')),
        PRIMARY KEY (boundary_key, boundary_version)
      );

      CREATE TABLE permission_boundary_entry (
        
        ${key('boundary_key', 128)},
        boundary_version integer NOT NULL,
        ${key('permission_key', 160)},
        definition jsonb NOT NULL,
        PRIMARY KEY (boundary_key, boundary_version, permission_key),
        CONSTRAINT fk_boundary_entry_boundary FOREIGN KEY (boundary_key, boundary_version)
          REFERENCES permission_boundary (boundary_key, boundary_version),
        CONSTRAINT fk_boundary_entry_permission FOREIGN KEY (permission_key)
          REFERENCES permission_catalog (permission_key)
      );
      CREATE INDEX ix_boundary_entry_permission ON permission_boundary_entry (permission_key);

      CREATE TABLE user_boundary (
        
        user_id uuid NOT NULL,
        ${key('permission_key', 160)},
        ${key('boundary_key', 128)},
        boundary_version integer NOT NULL,
        ${key('seed_owner', 128, true)},
        PRIMARY KEY (user_id, permission_key),
        CONSTRAINT fk_member_boundary_membership FOREIGN KEY (user_id)
          REFERENCES app_user (id),
        CONSTRAINT fk_member_boundary_entry FOREIGN KEY (boundary_key, boundary_version, permission_key)
          REFERENCES permission_boundary_entry (boundary_key, boundary_version, permission_key)
      );
      CREATE INDEX ix_member_boundary_entry
        ON user_boundary (boundary_key, boundary_version, permission_key);

      CREATE TABLE audit_outbox (
        
        event_id uuid NOT NULL,
        actor_id uuid NOT NULL,
        ${key('event_kind', 96)},
        ${key('permission_key', 160, true)},
        object_id uuid,
        policy_revision bigint NOT NULL,
        occurred_at timestamptz(6) NOT NULL,
        reason varchar(1000),
        safe_metadata jsonb NOT NULL,
        delivered_at timestamptz(6),
        delivery_attempts smallint NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 1000),
        lease_token uuid,
        lease_until timestamptz(6),
        dead_at timestamptz(6),
        PRIMARY KEY (event_id)
      );
      CREATE INDEX ix_audit_pending ON audit_outbox (delivered_at, occurred_at, event_id);
      CREATE INDEX ix_audit_outbox_pending ON audit_outbox (occurred_at, event_id) WHERE delivered_at IS NULL AND dead_at IS NULL;

      CREATE TABLE oidc_email_enrollment(
        user_id uuid PRIMARY KEY REFERENCES app_user(id),
        issuer text NOT NULL REFERENCES oidc_provider(issuer),
        email_canonical text NOT NULL CHECK (char_length(email_canonical) BETWEEN 3 AND 254 AND email_canonical = lower(email_canonical)),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        -- Actor id as in audit_outbox.actor_id (a Root/IAM user or the offline actor); no FK.
        created_by uuid NOT NULL,
        CONSTRAINT uq_oidc_email_enrollment UNIQUE (issuer, email_canonical),
        CONSTRAINT ck_oidc_email_enrollment_window CHECK (expires_at > created_at)
      );
      CREATE TABLE mfa_totp(
        user_id uuid PRIMARY KEY REFERENCES app_user(id),
        secret_ciphertext bytea NOT NULL CHECK (octet_length(secret_ciphertext) = 36),
        nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
        key_id text NOT NULL CHECK (key_id ~ '^[a-z0-9-]{1,32}$'),
        secret_version bigint NOT NULL DEFAULT 1 CHECK (secret_version > 0),
        confirmed_at timestamptz,
        last_used_step bigint CHECK (last_used_step >= 0),
        failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 1000),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp()
      );
      CREATE TABLE mfa_recovery_code(
        user_id uuid NOT NULL REFERENCES app_user(id),
        code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
        used_at timestamptz,
        PRIMARY KEY (user_id, code_hash)
      );
      CREATE VIEW iam_account WITH (security_invoker=true) AS SELECT id,state FROM app_user WHERE kind='iam';
    `);
    // Privileges. Functions created by this login get no PUBLIC execute (default privileges), each
    // gets its explicit grants, and the owner change comes last (triggers need EXECUTE first).
    await runner.query(`
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      REVOKE ALL ON public.iam_account FROM PUBLIC;
      REVOKE ALL ON public.oidc_email_enrollment, public.mfa_totp, public.mfa_recovery_code FROM PUBLIC;
      -- Fence and session resolution run as NOLOGIN owners with column-exact rights.
      GRANT SELECT(revision,min_runtime_capability,singleton),UPDATE(singleton) ON authz_state TO product_fence_owner;
      GRANT SELECT(id,email_verified,state,auth_epoch,kind),UPDATE(kind) ON app_user TO product_session_owner;
      GRANT SELECT(token_hash,user_id,auth_epoch,method,assurance,authenticated_at,reauthenticated_at,expires_at,revoked_at,last_seen_at,external_issuer,external_subject,binding_version,provider_version) ON application_session TO product_session_owner;
      GRANT SELECT(issuer,subject,user_id,enabled,binding_version) ON external_identity TO product_session_owner,product_bootstrap;
      GRANT SELECT(issuer,version,enabled) ON oidc_provider TO product_session_owner;
      GRANT SELECT(user_id,purpose,consumed_at,expires_at) ON one_time_token TO product_session_owner;
      GRANT SELECT(user_id) ON user_role,user_boundary,policy_rule,record_exception,mfa_totp TO product_session_owner;
      GRANT SELECT ON security_bootstrap_state TO product_session_owner;
      -- Authority catalog and facts.
      GRANT SELECT ON resource_type,permission_policy,permission_catalog,scope_template,role_definition,user_role,policy_rule,object_ref,record_exception,resource_relation_definition,relation_edge,user_relation,permission_boundary,permission_boundary_entry,user_boundary TO product_data,product_authority,product_sync,product_bootstrap;
      GRANT SELECT(id,state,auth_epoch) ON app_user TO product_data,product_authority,product_bootstrap;
      GRANT SELECT(kind) ON app_user TO product_authority;
      GRANT SELECT ON iam_account TO product_authority;
      GRANT SELECT,UPDATE(revision) ON authz_state TO product_identity,product_authority,product_bootstrap;
      GRANT SELECT,UPDATE ON authz_state TO product_sync;
      GRANT UPDATE(state,auth_epoch) ON app_user TO product_authority;
      GRANT INSERT,UPDATE,DELETE ON role_definition,user_role,policy_rule,record_exception,relation_edge,user_relation,user_boundary,object_ref TO product_authority;
      GRANT INSERT,UPDATE,DELETE ON resource_type,permission_policy,permission_catalog,scope_template,role_definition,policy_rule,resource_relation_definition,permission_boundary,permission_boundary_entry,relation_edge,user_boundary,oidc_provider TO product_sync;
      GRANT INSERT ON object_ref TO product_sync;
      GRANT INSERT ON audit_outbox TO product_data,product_identity,product_authority,product_sync,product_bootstrap;
      GRANT SELECT ON audit_outbox TO product_outbox;
      GRANT UPDATE(delivered_at,delivery_attempts,lease_token,lease_until,dead_at) ON audit_outbox TO product_outbox;
      -- Identity login: sessions, attempts, rate limit, enrollment, second factor; tokens only consumed.
      GRANT SELECT,INSERT,UPDATE,DELETE ON application_session,oidc_login_attempt,rate_limit TO product_identity;
      GRANT SELECT ON external_identity,oidc_provider,app_user,one_time_token TO product_identity;
      GRANT SELECT ON oidc_provider TO product_sync;
      GRANT INSERT(issuer,subject,user_id) ON external_identity TO product_identity;
      GRANT INSERT(id,email_canonical,email_verified,state,auth_epoch) ON app_user TO product_identity;
      GRANT UPDATE(email_verified,state,auth_epoch) ON app_user TO product_identity;
      GRANT UPDATE(consumed_at) ON one_time_token TO product_identity;
      GRANT SELECT,INSERT,DELETE ON oidc_email_enrollment TO product_identity;
      GRANT SELECT,INSERT,UPDATE,DELETE ON mfa_totp TO product_identity;
      GRANT SELECT,INSERT,DELETE ON mfa_recovery_code TO product_identity;
      GRANT UPDATE(used_at) ON mfa_recovery_code TO product_identity;
      -- Bootstrap login: Root promotion, activation proof, Root email, second factor reset.
      GRANT SELECT,UPDATE ON security_bootstrap_state TO product_bootstrap;
      GRANT INSERT ON one_time_token TO product_bootstrap;
      GRANT SELECT(user_id,purpose,consumed_at),UPDATE(consumed_at) ON one_time_token TO product_bootstrap;
      GRANT UPDATE(email_canonical,email_verified,state,auth_epoch,kind) ON app_user TO product_bootstrap;
      GRANT SELECT(email_canonical) ON app_user TO product_bootstrap;
      GRANT SELECT(kind) ON app_user TO product_bootstrap;
      GRANT INSERT(id,email_canonical,state) ON app_user TO product_bootstrap;
      GRANT SELECT(issuer,enabled) ON oidc_provider TO product_bootstrap;
      GRANT SELECT(user_id),INSERT,DELETE ON oidc_email_enrollment TO product_bootstrap;
      GRANT SELECT(user_id),DELETE ON mfa_totp,mfa_recovery_code TO product_bootstrap;
      -- Definer rights of product_account_owner: exactly what its view and functions read or write.
      GRANT SELECT(id,email_canonical,state,kind,auth_epoch),INSERT(id,email_canonical,state),UPDATE(state,auth_epoch) ON app_user TO product_account_owner;
      GRANT SELECT(issuer,enabled) ON oidc_provider TO product_account_owner;
      GRANT SELECT(issuer,user_id,enabled) ON external_identity TO product_account_owner;
      GRANT SELECT(user_id,expires_at),INSERT ON oidc_email_enrollment TO product_account_owner;
      CREATE VIEW account_directory WITH (security_barrier=true) AS ${accountDirectoryView};
      REVOKE ALL ON account_directory FROM PUBLIC;
      GRANT SELECT ON account_directory TO product_data,product_authority;
      ALTER VIEW account_directory OWNER TO product_account_owner;
    `);
    await runner.query(`
      CREATE FUNCTION public.authz_acquire_shared_fence(p_capability integer) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
        SET search_path=pg_catalog,pg_temp AS $fn$${sharedFenceBody}$fn$;
      REVOKE ALL ON FUNCTION public.authz_acquire_shared_fence(integer) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.authz_acquire_shared_fence(integer) TO product_data,product_identity;
      ALTER FUNCTION public.authz_acquire_shared_fence(integer) OWNER TO product_fence_owner;
      CREATE FUNCTION public.resolve_session(p_digest bytea)
        RETURNS TABLE(user_id uuid,kind text,state text,auth_epoch bigint,method text,assurance text,authenticated_at timestamptz,reauthenticated_at timestamptz,expires_at timestamptz)
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${resolveSessionOidcBody}$fn$;
      REVOKE ALL ON FUNCTION public.resolve_session(bytea) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.resolve_session(bytea) TO product_data,product_identity,product_authority;
      ALTER FUNCTION public.resolve_session(bytea) OWNER TO product_session_owner;
      CREATE FUNCTION public.provision_oidc_account(p_user uuid, p_email text, p_issuer text, p_actor uuid) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${provisionOidcAccountBody}$fn$;
      REVOKE ALL ON FUNCTION public.provision_oidc_account(uuid,text,text,uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.provision_oidc_account(uuid,text,text,uuid) TO product_data;
      ALTER FUNCTION public.provision_oidc_account(uuid,text,text,uuid) OWNER TO product_account_owner;
      CREATE FUNCTION public.reactivate_iam_account(p_user uuid) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${reactivateIamAccountBody}$fn$;
      REVOKE ALL ON FUNCTION public.reactivate_iam_account(uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.reactivate_iam_account(uuid) TO product_authority;
      ALTER FUNCTION public.reactivate_iam_account(uuid) OWNER TO product_account_owner;

      -- Invoker-rights guards stay owned by the migration login.
      CREATE FUNCTION public.protect_product_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${productStateBody}$fn$;
      CREATE FUNCTION public.protect_product_rows() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${productRowsIamBody}$fn$;
      CREATE FUNCTION public.protect_account_lifecycle() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${accountLifecycleBody}$fn$;
      CREATE FUNCTION public.protect_token_consumption() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${tokenConsumptionBody}$fn$;
      CREATE FUNCTION public.protect_binding_ref() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${protectBindingRefBody}$fn$;
      CREATE FUNCTION public.require_email_epoch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${requireEmailEpochBody}$fn$;
      CREATE FUNCTION public.protect_mfa_totp() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${protectMfaTotpBody}$fn$;
      CREATE FUNCTION public.protect_mfa_recovery_code() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${protectMfaRecoveryCodeBody}$fn$;
      CREATE FUNCTION public.mfa_epoch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${mfaEpochBody}$fn$;
      REVOKE ALL ON FUNCTION public.protect_product_state(), public.protect_product_rows(), public.protect_account_lifecycle(),
        public.protect_token_consumption(), public.protect_binding_ref(), public.require_email_epoch(),
        public.protect_mfa_totp(), public.protect_mfa_recovery_code(), public.mfa_epoch() FROM PUBLIC;
      CREATE TRIGGER protect_product_state BEFORE UPDATE ON public.security_bootstrap_state FOR EACH ROW EXECUTE FUNCTION public.protect_product_state();
      CREATE TRIGGER protect_product_state BEFORE UPDATE ON public.authz_state FOR EACH ROW EXECUTE FUNCTION public.protect_product_state();
      CREATE TRIGGER protect_account_lifecycle BEFORE UPDATE ON public.app_user FOR EACH ROW EXECUTE FUNCTION public.protect_account_lifecycle();
      CREATE TRIGGER protect_token_consumption BEFORE UPDATE ON public.one_time_token FOR EACH ROW EXECUTE FUNCTION public.protect_token_consumption();
      CREATE TRIGGER protect_binding_ref BEFORE UPDATE ON public.external_identity FOR EACH ROW EXECUTE FUNCTION public.protect_binding_ref();
      CREATE TRIGGER require_email_epoch BEFORE UPDATE OF email_canonical,email_verified ON public.app_user FOR EACH ROW EXECUTE FUNCTION public.require_email_epoch();
      CREATE TRIGGER protect_mfa_totp BEFORE INSERT OR UPDATE OR DELETE ON public.mfa_totp FOR EACH ROW EXECUTE FUNCTION public.protect_mfa_totp();
      CREATE TRIGGER mfa_epoch AFTER UPDATE OR DELETE ON public.mfa_totp FOR EACH ROW EXECUTE FUNCTION public.mfa_epoch();
      CREATE TRIGGER protect_mfa_recovery_code BEFORE INSERT OR UPDATE OR DELETE ON public.mfa_recovery_code FOR EACH ROW EXECUTE FUNCTION public.protect_mfa_recovery_code();
    `);
    for (const table of protectedRowTables)
      await runner.query(
        `CREATE TRIGGER protect_product_rows BEFORE INSERT OR UPDATE OR DELETE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.protect_product_rows()`,
      );
    // Root guards: SECURITY DEFINER, owned by the session owner; triggers first, then REVOKE and owner change.
    for (const [name, body] of rootGuards)
      await runner.query(
        `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$${body}$fn$`,
      );
    await runner.query(`
      CREATE TRIGGER guard_root_kind BEFORE INSERT OR UPDATE OF kind ON public.app_user
        FOR EACH ROW EXECUTE FUNCTION public.guard_root_kind();
      CREATE CONSTRAINT TRIGGER require_root_marker_kind AFTER UPDATE OF kind ON public.app_user
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_root_marker_kind();
      CREATE TRIGGER guard_root_lifecycle BEFORE UPDATE OF state,auth_epoch ON public.app_user
        FOR EACH ROW EXECUTE FUNCTION public.guard_root_lifecycle();
      CREATE TRIGGER guard_root_activation BEFORE INSERT ON public.one_time_token
        FOR EACH ROW EXECUTE FUNCTION public.guard_root_activation();
    `);
    for (const table of iamTables)
      await runner.query(
        `CREATE TRIGGER guard_root_not_iam_subject BEFORE INSERT OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.guard_root_not_iam_subject()`,
      );
    for (const [name] of rootGuards)
      await runner.query(`
        REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC;
        ALTER FUNCTION public.${name}() OWNER TO product_session_owner;
      `);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error('Product baseline requires an explicit restore; automatic downgrade is disabled'),
    );
  }
}

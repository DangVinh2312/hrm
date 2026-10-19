// Synthetic OIDC accounts and sessions for tests (ADR 0027: Google is the only sign-in). Rows are
// written by the logins that write them at runtime: the provider by the owner (migration) login,
// bindings and sessions by the identity login, as an OIDC login would leave them.
import { randomBytes } from 'node:crypto';
import { sessionDigest } from '../dist/auth/services/product-identity.service.js';

/** A TypeORM DataSource or EntityManager. */
interface Queryable {
  query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T>;
}

export const FIXTURE_ISSUER = 'https://idp.fixture';

/** Enabled fixture provider at version 1; a second call changes nothing. */
export async function fixtureProvider(owner: Queryable, issuer = FIXTURE_ISSUER): Promise<void> {
  await owner.query(
    'INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true) ON CONFLICT (issuer) DO NOTHING',
    [issuer],
  );
}

/** Binds (issuer, subject) to the account (one enabled binding per account, migration 017). */
export async function bindAccount(
  identity: Queryable,
  userId: string,
  subject = `sub-${userId}`,
  issuer = FIXTURE_ISSUER,
): Promise<void> {
  await identity.query('INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)', [
    issuer,
    subject,
    userId,
  ]);
}

/**
 * A session of the account's enabled binding, valid for an hour. `fresh` is a step-up 5 s ago
 * (the WSL clock steps back under load), as a 2FA verify would leave it. `secret` lets a test
 * that already holds a token use it; otherwise a new one is drawn.
 */
export async function oidcSession(
  identity: Queryable,
  userId: string,
  options: { readonly fresh?: boolean; readonly secret?: string } = {},
): Promise<string> {
  const secret = options.secret ?? randomBytes(32).toString('base64url');
  const rows = await identity.query<unknown[]>(
    `INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,reauthenticated_at,expires_at)
     SELECT $1,u.id,u.auth_epoch,'oidc','oidc',e.issuer,e.subject,e.binding_version,p.version,statement_timestamp(),
       CASE WHEN $3 THEN statement_timestamp()-interval '5 seconds' END,statement_timestamp()+interval '1 hour'
     FROM app_user u JOIN external_identity e ON e.user_id=u.id AND e.enabled
       JOIN oidc_provider p ON p.issuer=e.issuer AND p.enabled
     WHERE u.id=$2 RETURNING 1`,
    [sessionDigest(secret), userId, options.fresh === true],
  );
  if (rows.length !== 1)
    throw new Error('fixture account needs one enabled binding at an enabled provider');
  return secret;
}

/**
 * What a completed OIDC activation leaves on a pending account (the Root after bootstrap, or an
 * invited account): its proofs consumed, active, a new epoch. Written by the identity login.
 */
export async function activateAccount(identity: Queryable, userId: string): Promise<void> {
  await identity.query(
    'UPDATE one_time_token SET consumed_at=statement_timestamp() WHERE user_id=$1 AND consumed_at IS NULL',
    [userId],
  );
  await identity.query(
    `UPDATE app_user SET state='active',auth_epoch=auth_epoch+1 WHERE id=$1 AND state='pending'`,
    [userId],
  );
}

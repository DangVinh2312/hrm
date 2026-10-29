import { timingSafeEqual } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import type { ProductTransaction } from '../../database/product-transaction.runner.js';
import {
  ProductAuthenticationError,
  type ProductIdentityService,
  secretDigest,
  sessionDigest,
} from './product-identity.service.js';

/** A live Root activation: pending Root, unexpired enrollment of (issuer, email), live token. */
export interface RootInvitation {
  user_id: string;
  email: string;
  auth_epoch: string;
  token_hash: Buffer;
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof QueryFailedError && (error.driverError as { code?: unknown }).code === '23505';

/**
 * The live email enrollment at `issuer`: unexpired, its account pending, IAM, with
 * that same email and no external identity yet. `lock` takes the account row
 * FOR UPDATE, so concurrent first logins serialize and only the first one still matches. Root
 * rows never match (`kind = 'iam'`): a Root is opened only by its activation token.
 */
export async function liveEnrollment(
  tx: ProductTransaction,
  issuer: string,
  email: string,
  lock: boolean,
): Promise<string | undefined> {
  const rows = await tx.manager.query<{ user_id: string }[]>(
    `SELECT u.id AS user_id FROM oidc_email_enrollment n JOIN app_user u ON u.id=n.user_id
     WHERE n.issuer=$1 AND n.email_canonical=$2 AND n.expires_at>statement_timestamp()
       AND u.state='pending' AND u.kind='iam' AND u.email_canonical=$2
       AND NOT EXISTS(SELECT 1 FROM external_identity e WHERE e.user_id=u.id)${lock ? ' FOR UPDATE OF u' : ''}`,
    [issuer, email],
  );
  // UNIQUE(issuer, email_canonical) allows at most one row; more would be a broken invariant.
  return rows.length === 1 ? rows[0]?.user_id : undefined;
}

/**
 * First verified login of an email-enrolled account, in the caller's exclusive identity
 * transaction: binds (issuer, sub), activates the account and consumes the enrollment, all in
 * one commit. Any mismatch is the generic authentication failure.
 */
export async function bindEnrollment(
  tx: ProductTransaction,
  identity: ProductIdentityService,
  issuer: string,
  subject: string,
  email: string,
): Promise<void> {
  const userId = await liveEnrollment(tx, issuer, email, true);
  if (userId === undefined) throw new ProductAuthenticationError();
  const bound = await tx.manager.query<unknown[]>(
    `SELECT 1 FROM external_identity WHERE issuer=$1 AND subject=$2`,
    [issuer, subject],
  );
  if (bound.length) throw new ProductAuthenticationError();
  const consumed = await tx.manager.query<unknown[]>(
    `WITH consumed AS (DELETE FROM oidc_email_enrollment WHERE user_id=$1 AND issuer=$2 AND email_canonical=$3 RETURNING user_id) SELECT * FROM consumed`,
    [userId, issuer, email],
  );
  if (consumed.length !== 1) throw new ProductAuthenticationError();
  try {
    await tx.manager.query(
      `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)`,
      [issuer, subject, userId],
    );
  } catch (error) {
    // A concurrent binding of this subject committed first.
    if (isUniqueViolation(error)) throw new ProductAuthenticationError();
    throw error;
  }
  await tx.manager.query(
    `UPDATE app_user SET state='active',email_verified=true,auth_epoch=auth_epoch+1 WHERE id=$1`,
    [userId],
  );
  await identity.invalidate(tx, userId);
  await identity.audit(tx, userId, 'identity.oidc-activation');
}

/**
 * Live Root activations, found by token (begin) or by user (callback), locking the
 * account and token rows. The enrollment pins the issuer and email; no binding takes part.
 * Several live tokens of one Root are fine; none, or several users, is not.
 */
export async function rootInvitation(
  tx: ProductTransaction,
  issuer: string,
  by: { token: string } | { userId: string | null },
): Promise<RootInvitation[]> {
  const rows = await tx.manager.query<RootInvitation[]>(
    `SELECT u.id AS user_id,n.email_canonical AS email,u.auth_epoch,t.token_hash
     FROM one_time_token t JOIN app_user u ON u.id=t.user_id
       JOIN oidc_email_enrollment n ON n.user_id=u.id AND n.issuer=$1
         AND n.email_canonical=u.email_canonical AND n.expires_at>statement_timestamp()
     WHERE ${'token' in by ? 't.token_hash=$2' : 't.user_id=$2'} AND t.purpose='oidc-activation'
       AND t.consumed_at IS NULL AND t.expires_at>statement_timestamp()
       AND u.state='pending' AND u.kind='root'
     FOR UPDATE OF u,t`,
    [issuer, 'token' in by ? sessionDigest(by.token) : by.userId],
  );
  if (!rows[0] || rows.some((r) => r.user_id !== rows[0]!.user_id))
    throw new ProductAuthenticationError();
  return rows;
}

/** Digest of (user, issuer, email, epoch, token): a reissue or any change voids a begun attempt. */
export function rootEnrollmentHash(invitation: RootInvitation, issuer: string): Buffer {
  return secretDigest(
    JSON.stringify([
      invitation.user_id,
      issuer,
      invitation.email,
      invitation.auth_epoch,
      invitation.token_hash.toString('hex'),
    ]),
  );
}

/**
 * Completes a Root activation in the caller's `revoke` transaction: the ID token's verified email
 * must be the enrollment's, `(issuer, sub)` must be new, and binding, enrollment, token, state,
 * email verification and epoch change in one commit. Anything else is the generic failure.
 */
export async function activateRoot(
  tx: ProductTransaction,
  identity: ProductIdentityService,
  input: {
    readonly issuer: string;
    readonly subject: string;
    readonly email: string | undefined;
    readonly userId: string | null;
    readonly attemptHash: Buffer | null;
  },
): Promise<void> {
  const { issuer, subject, email, userId, attemptHash } = input;
  if (email === undefined || userId === null || attemptHash === null)
    throw new ProductAuthenticationError();
  const invitation = (await rootInvitation(tx, issuer, { userId })).find((r) => {
    const hash = rootEnrollmentHash(r, issuer);
    return hash.length === attemptHash.length && timingSafeEqual(attemptHash, hash);
  });
  if (!invitation || invitation.user_id !== userId || invitation.email !== email)
    throw new ProductAuthenticationError();
  const consumed = await tx.manager.query<unknown[]>(
    `WITH consumed AS (DELETE FROM oidc_email_enrollment WHERE user_id=$1 AND issuer=$2 AND email_canonical=$3 RETURNING user_id) SELECT * FROM consumed`,
    [userId, issuer, email],
  );
  if (consumed.length !== 1) throw new ProductAuthenticationError();
  try {
    await tx.manager.query(
      `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)`,
      [issuer, subject, userId],
    );
  } catch (error) {
    // The subject belongs to another account, or a concurrent activation bound this one first.
    if (isUniqueViolation(error)) throw new ProductAuthenticationError();
    throw error;
  }
  // One UPDATE: require_email_epoch wants the epoch to advance with email_verified.
  await tx.manager.query(
    `UPDATE app_user SET state='active',email_verified=true,auth_epoch=auth_epoch+1 WHERE id=$1`,
    [userId],
  );
  await identity.invalidate(tx, userId);
  await identity.audit(tx, userId, 'identity.oidc-activation');
}

import { QueryFailedError } from 'typeorm';
import type { AuthorizationCore } from '../core/authorization.factory.js';
import type { IdentityId } from '../core/authorization.types.js';
import { ReleaseRejectedError, type RejectReason } from '../helpers/release-content.helper.js';
import { ProductTransactionRunner } from '../../database/product-transaction.runner.js';
import {
  type ProductAuditRepository,
  PRODUCT_OFFLINE_ACTOR,
} from '../../audit/product-audit.repository.js';
import { canonicalLoginEmail } from '../../auth/services/product-identity.service.js';

const reject = (reason: RejectReason, detail: string): never => {
  throw new ReleaseRejectedError(reason, detail);
};

export interface RootEmailInput {
  readonly operationId: string;
  readonly userId: IdentityId;
  /** Offline operator input, canonicalized here; PII, so never logged or audited. */
  readonly email: string;
}

/**
 * Offline capability only (ADR 0023 §4): gives the active Root a new email,
 * unverified until a verified IdP claim of that email at login. auth_epoch advances in the same
 * row update, which ends every session; fenced and audited without the email. The same email
 * again changes nothing.
 */
export async function setRootEmail(
  runner: ProductTransactionRunner,
  audit: ProductAuditRepository,
  input: RootEmailInput,
  core: AuthorizationCore,
): Promise<{ changed: boolean }> {
  let email: string | undefined;
  try {
    email = canonicalLoginEmail(input.email);
  } catch {
    email = undefined;
  }
  if (!core.isCanonicalUuid(input.operationId) || !core.isCanonicalUuid(input.userId) || !email)
    reject('invalid_release', 'invalid Root email input');
  if (input.userId === PRODUCT_OFFLINE_ACTOR)
    reject('invalid_release', 'offline actor id cannot be a user');
  return runner.run('bootstrap', async (tx) => {
    const m = tx.manager;
    const [target] = await m.query<{ email: string | null; eligible: boolean }[]>(
      `SELECT u.email_canonical email,u.kind='root' AND u.state='active' eligible
       FROM app_user u WHERE u.id=$1 FOR NO KEY UPDATE`,
      [input.userId],
    );
    if (!target?.eligible) reject('collision', 'only the active Root takes an email');
    if (target!.email === email) return { changed: false };
    try {
      await m.query(
        `UPDATE app_user SET email_canonical=$2,email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`,
        [input.userId, email],
      );
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: unknown }).code === '23505'
      )
        reject('collision', 'email belongs to another account');
      throw error;
    }
    await audit.appendProductAudit(tx, {
      kind: 'root.set-email',
      actor: PRODUCT_OFFLINE_ACTOR,
      target: { userId: input.userId },
      operationId: input.operationId,
    });
    return { changed: true };
  });
}

export interface RootRevocationInput {
  readonly operationId: string;
  readonly userId: IdentityId;
  /** Reference of the independent approval record; never a secret. */
  readonly approval: string;
  readonly reason: string;
}

/**
 * Offline capability only: suspends the Root and ends its sessions (auth_epoch) under the
 * exclusive fence with audit. The marker stays, so no new Root can follow (ADR 0012).
 */
export async function revokeProductRoot(
  runner: ProductTransactionRunner,
  audit: ProductAuditRepository,
  input: RootRevocationInput,
  core: AuthorizationCore,
): Promise<{ revoked: boolean }> {
  const printable = (value: unknown, max: number) =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/\p{Cc}/u.test(value);

  if (
    !core.isCanonicalUuid(input.operationId) ||
    !core.isCanonicalUuid(input.userId) ||
    !printable(input.approval, 200) ||
    !printable(input.reason, 1000)
  )
    reject('invalid_release', 'invalid Root revocation input');
  return runner.run('bootstrap', async (tx) => {
    const removed = await tx.manager.query<unknown[]>(
      `WITH revoked AS (UPDATE app_user SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1 AND kind='root' AND state<>'suspended' RETURNING 1) SELECT * FROM revoked`,
      [input.userId],
    );
    if (!removed.length) return { revoked: false };
    await audit.appendProductAudit(tx, {
      kind: 'root.revoke',
      actor: PRODUCT_OFFLINE_ACTOR,
      target: { userId: input.userId },
      operationId: input.operationId,
      approval: input.approval,
      reason: input.reason,
    });
    return { revoked: true };
  });
}

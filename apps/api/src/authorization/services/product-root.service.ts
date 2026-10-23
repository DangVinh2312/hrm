import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type EntityManager, QueryFailedError } from 'typeorm';
import type { IdentityId } from '../core/authorization.types.js';
import { ReleaseRejectedError, type RejectReason } from '../helpers/release-content.helper.js';
import { ProtectedStateRepository } from '../repositories/protected-state.repository.js';
import { ProductTransactionRunner } from '../../database/product-transaction.runner.js';
import {
  type ProductAuditRepository,
  PRODUCT_OFFLINE_ACTOR,
} from '../../audit/product-audit.repository.js';
import { canonicalLoginEmail } from '../../auth/services/product-identity.service.js';
import { type ProductReleaseManifest, verifiedProductCore } from './product-manifest.service.js';

const protectedState = new ProtectedStateRepository();

const reject = (reason: RejectReason, detail: string): never => {
  throw new ReleaseRejectedError(reason, detail);
};

function loginEmail(value: string): string {
  try {
    return canonicalLoginEmail(value);
  } catch {
    return reject('invalid_release', 'invalid Root email');
  }
}

async function requireEnabledProvider(m: EntityManager, issuer: string): Promise<void> {
  const [provider] = await m.query<unknown[]>(
    'SELECT 1 FROM oidc_provider WHERE issuer=$1 AND enabled',
    [issuer],
  );
  if (!provider) reject('missing_reference', 'issuer is not an enabled provider');
}

/** The 15 minute enrollment pinning the Root's (issuer, email) to the Google login (ADR 0027 §3). */
async function pinEnrollment(
  m: EntityManager,
  userId: string,
  issuer: string,
  email: string,
): Promise<void> {
  await m.query(
    `INSERT INTO oidc_email_enrollment(user_id,issuer,email_canonical,expires_at,created_by) VALUES($1,$2,$3,statement_timestamp()+interval '15 minutes',$4)`,
    [userId, issuer, email, PRODUCT_OFFLINE_ACTOR],
  );
}

/** The one-time activation token, generated here and returned only after commit to the offline tool. */
async function issueActivationToken(m: EntityManager, userId: string): Promise<string> {
  const activationSecret = randomBytes(32).toString('base64url');
  await m.query(
    `INSERT INTO one_time_token(token_hash,user_id,purpose,expires_at) VALUES($1,$2,'oidc-activation',statement_timestamp()+interval '15 minutes')`,
    [createHash('sha256').update(activationSecret).digest(), userId],
  );
  return activationSecret;
}

export interface RootBootstrapInput {
  readonly operationId: string;
  readonly issuer: string;
  /** Offline operator input, canonicalized here; PII, so never logged or audited. */
  readonly email: string;
}

/**
 * Offline capability only (ADR 0027 §3): creates the one Root from an email. The account is
 * inserted as a pending IAM user with a generated id, then promoted to `kind = 'root'` in the
 * same READ COMMITTED transaction (the DB guard still allows only that promotion), with the
 * permanent marker and the proof. No role, grant or boundary is written (ADR 0012). The same
 * operation and email again changes nothing; any other bootstrap is a collision.
 */
export async function bootstrapProductRoot(
  runner: ProductTransactionRunner,
  audit: ProductAuditRepository,
  release: ProductReleaseManifest,
  input: RootBootstrapInput,
): Promise<{ initialized: boolean; userId: IdentityId; activationSecret?: string }> {
  const core = verifiedProductCore(release);
  if (!core || !core.isCanonicalUuid(input.operationId) || !input.issuer)
    reject('invalid_release', 'invalid bootstrap input');
  const email = loginEmail(input.email);
  return runner.run('bootstrap', async (tx) => {
    const m = tx.manager;
    const [marker] = await m.query<
      { operation_id: string | null; email: string | null; target: string | null }[]
    >(
      `SELECT s.operation_id,s.target_user_id::text target,u.email_canonical email
       FROM security_bootstrap_state s LEFT JOIN app_user u ON u.id=s.target_user_id
       WHERE s.singleton FOR UPDATE OF s`,
    );
    if (!marker) reject('not_ready', 'bootstrap marker missing');
    if (marker!.operation_id) {
      if (marker!.operation_id === input.operationId && marker!.email === email && marker!.target)
        return { initialized: false, userId: marker!.target as IdentityId };
      reject('collision', 'Root bootstrap already initialized');
    }
    const [state] = await m.query<{ hash: string; materialized: string | null }[]>(
      `SELECT encode(manifest_hash,'hex') hash,encode(materialized_hash,'hex') materialized FROM authz_state WHERE singleton`,
    );
    if (state?.hash !== release.hash || state.materialized !== (await protectedState.hash(m)))
      reject('not_ready', 'manifest must be applied without drift');
    await requireEnabledProvider(m, input.issuer);
    const userId = randomUUID() as IdentityId;
    try {
      await m.query(`INSERT INTO app_user(id,email_canonical,state) VALUES($1,$2,'pending')`, [
        userId,
        email,
      ]);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: unknown }).code === '23505'
      )
        reject('collision', 'email belongs to another account');
      throw error;
    }
    await pinEnrollment(m, userId, input.issuer, email);
    // Promotion first: guard_root_kind refuses a target that already holds a live activation token.
    await m.query(`UPDATE app_user SET kind='root' WHERE id=$1`, [userId]);
    const activationSecret = await issueActivationToken(m, userId);
    await m.query(
      'UPDATE security_bootstrap_state SET operation_id=$1,target_user_id=$2,initialized_at=statement_timestamp() WHERE singleton',
      [input.operationId, userId],
    );
    await audit.appendProductAudit(tx, {
      kind: 'root.bootstrap',
      actor: PRODUCT_OFFLINE_ACTOR,
      target: { userId },
      operationId: input.operationId,
      method: 'oidc',
    });
    return { initialized: true, userId, activationSecret };
  });
}

export interface RootReissueInput {
  readonly issuer: string;
}

/**
 * Offline capability only (ADR 0027 §4): a fresh proof for the still pending bootstrap Root that
 * has no binding yet (expired or lost artifact). Earlier proofs and the enrollment are replaced
 * in the same fenced transaction, with audit.
 */
export async function reissueRootActivation(
  runner: ProductTransactionRunner,
  audit: ProductAuditRepository,
  input: RootReissueInput,
): Promise<{ activationSecret: string }> {
  if (!input.issuer) reject('invalid_release', 'invalid Root reissue input');
  return runner.run('bootstrap', async (tx) => {
    const m = tx.manager;
    const [target] = await m.query<
      { id: string; state: string; root: boolean; email: string | null; bindings: number }[]
    >(
      `SELECT u.id,u.state,u.kind='root' root,u.email_canonical email,
        (SELECT count(*) FROM external_identity e WHERE e.user_id=u.id)::int bindings
       FROM security_bootstrap_state b JOIN app_user u ON u.id=b.target_user_id
       WHERE b.singleton AND b.initialized_at IS NOT NULL FOR UPDATE OF b FOR NO KEY UPDATE OF u`,
    );
    if (!target || target.state !== 'pending' || !target.root)
      reject('collision', 'only the pending bootstrap Root can receive a new proof');
    if (!target!.email || target!.bindings !== 0)
      reject('missing_reference', 'Root target does not fit the activation method');
    await requireEnabledProvider(m, input.issuer);
    await m.query(
      `UPDATE one_time_token SET consumed_at=statement_timestamp() WHERE user_id=$1 AND purpose='oidc-activation' AND consumed_at IS NULL`,
      [target!.id],
    );
    await m.query('DELETE FROM oidc_email_enrollment WHERE user_id=$1', [target!.id]);
    await pinEnrollment(m, target!.id, input.issuer, target!.email!);
    const activationSecret = await issueActivationToken(m, target!.id);
    await audit.appendProductAudit(tx, {
      kind: 'root.reissue',
      actor: PRODUCT_OFFLINE_ACTOR,
      target: { userId: target!.id },
      method: 'oidc',
    });
    return { activationSecret };
  });
}

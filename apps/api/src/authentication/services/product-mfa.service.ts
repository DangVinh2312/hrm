import { randomBytes } from 'node:crypto';
import type {
  ProductTransaction,
  ProductTransactionRunner,
} from '../../database/product-transaction.runner.js';
import {
  type ProductAuditRepository,
  PRODUCT_OFFLINE_ACTOR,
} from '../../audit/product-audit.repository.js';
import {
  hasConfirmedSecondFactor,
  ProductAuthenticationError,
  type ProductIdentityService,
  type ProductSession,
  newSessionSecret,
  sessionDigest,
} from './product-identity.service.js';
import {
  type MfaKeyRing,
  type SealedTotpSecret,
  decryptTotpSecret,
  encryptTotpSecret,
} from '../helpers/mfa-encryption.helper.js';
import {
  TOTP_SECRET_BYTES,
  base32Encode,
  formatRecoveryCode,
  matchTotp,
  newRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeHash,
  totpUri,
} from '../helpers/totp.helper.js';

/** The account already has (setup/verify) or lacks (confirm/verify/remove) the factor asked about. */
export class ProductMfaConflict extends Error {}

/** The action needs a step-up from the last 300 s: 403, like a missing `fresh@1`. */
export class ProductStepUpRequired extends Error {}

export interface ProductMfaStatus {
  readonly status: 'none' | 'pending' | 'enabled';
  readonly recoveryCodesRemaining: number;
}

/** Shown once: the authenticator URI and the same secret as base32 text for manual entry. */
export interface ProductMfaSetup {
  readonly uri: string;
  readonly secret: string;
}

/** Exactly one proof; the HTTP layer has validated the shape. */
export type ProductMfaProof = { readonly code: string } | { readonly recoveryCode: string };

const RECOVERY_CODES = 10;
const SETUP_MINUTES = 15;

interface FactorRow {
  readonly secret_ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly key_id: string;
  readonly secret_version: string;
  readonly confirmed: boolean;
  readonly last_used_step: string | null;
  readonly live: boolean;
  /** Current TOTP step by the DB clock of this statement. */
  readonly step: string;
}

/**
 * TOTP second factor and recovery codes of the session's own account. Every change
 * runs in one fenced transaction that first locks the account row, so setup, confirm, verify,
 * regeneration, removal and an offline reset of one account are serialized. HMAC and AES-GCM are
 * cheap, so the code is checked inside that transaction against the row it locked.
 */
export class ProductMfaService {
  constructor(
    private readonly identity: ProductIdentityService,
    private readonly keys: MfaKeyRing,
  ) {}

  /** Boot check (fail closed): every stored key id must be in the configured key ring. */
  async verifyKeyCoverage(): Promise<void> {
    const rows = await this.identity.transactions.run('identity', (tx) =>
      tx.manager.query<{ key_id: string }[]>('SELECT DISTINCT key_id FROM mfa_totp'),
    );
    if (rows.some((row) => !this.keys.ids.has(row.key_id)))
      throw new Error('MFA key ring does not cover the stored second factors');
  }

  async status(secret: string): Promise<ProductMfaStatus> {
    return this.identity.transactions.run('identity', async (tx) => {
      const actor = await this.identity.authenticate(tx, secret);
      const [row] = await tx.manager.query<{ confirmed: boolean | null; remaining: number }[]>(
        `SELECT (SELECT confirmed_at IS NOT NULL FROM mfa_totp WHERE user_id=$1) confirmed,
           (SELECT count(*)::int FROM mfa_recovery_code WHERE user_id=$1 AND used_at IS NULL) remaining`,
        [actor.userId],
      );
      const status =
        row?.confirmed === true ? 'enabled' : row?.confirmed === false ? 'pending' : 'none';
      return { status, recoveryCodesRemaining: status === 'enabled' ? (row?.remaining ?? 0) : 0 };
    });
  }

  /** New unconfirmed secret, replacing an earlier setup; refused once a factor is confirmed. */
  async setup(secret: string, clientKey: string): Promise<ProductMfaSetup> {
    await this.#limit(secret, clientKey);
    const raw = randomBytes(TOTP_SECRET_BYTES);
    const result = await this.identity.transactions.run('identity', async (tx) => {
      const actor = await this.identity.authenticate(tx, secret);
      const email = await this.#lockAccount(tx, actor.userId);
      const sealed = encryptTotpSecret(this.keys, actor.userId, raw);
      const [existing] = await tx.manager.query<{ confirmed: boolean }[]>(
        'SELECT confirmed_at IS NOT NULL confirmed FROM mfa_totp WHERE user_id=$1',
        [actor.userId],
      );
      if (existing?.confirmed) throw new ProductMfaConflict();
      if (existing)
        await tx.manager.query(
          `UPDATE mfa_totp SET secret_ciphertext=$2,nonce=$3,key_id=$4,secret_version=secret_version+1,created_at=statement_timestamp(),failed_attempts=0 WHERE user_id=$1`,
          [actor.userId, sealed.ciphertext, sealed.nonce, sealed.keyId],
        );
      else
        await tx.manager.query(
          'INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,$2,$3,$4)',
          [actor.userId, sealed.ciphertext, sealed.nonce, sealed.keyId],
        );
      await this.identity.audit(tx, actor.userId, 'identity.mfa-setup');
      return { uri: totpUri(raw, email), secret: base32Encode(raw) };
    });
    raw.fill(0);
    return result;
  }

  /**
   * Confirms the setup with a code: the factor becomes active (the trigger ends every session),
   * ten recovery codes are shown once, and the caller's session continues as a fresh copy.
   */
  async confirm(
    secret: string,
    code: string,
    clientKey: string,
  ): Promise<{ readonly session: ProductSession; readonly recoveryCodes: readonly string[] }> {
    await this.#limit(secret, clientKey);
    return this.identity.transactions.run('revoke', async (tx) => {
      const actor = await this.identity.authenticate(tx, secret);
      await this.#lockAccount(tx, actor.userId);
      const row = await this.#factor(tx, actor.userId);
      if (!row || row.confirmed || !row.live) throw new ProductMfaConflict();
      const step = this.#match(actor.userId, row, code);
      // A wrong code at confirmation is not counted: the setup's secret came from this session.
      if (step === undefined) throw new ProductAuthenticationError();
      // A setup sealed before a key rotation is re-encrypted by the same UPDATE.
      const sealed = this.#resealed(actor.userId, row);
      const changed = await tx.manager.query<unknown[]>(
        `WITH changed AS (UPDATE mfa_totp SET confirmed_at=statement_timestamp(),last_used_step=$2,failed_attempts=0,
             secret_ciphertext=$4,nonce=$5,key_id=$6
           WHERE user_id=$1 AND confirmed_at IS NULL AND secret_version=$3 RETURNING 1) SELECT * FROM changed`,
        [
          actor.userId,
          step.toString(),
          row.secret_version,
          sealed.ciphertext,
          sealed.nonce,
          sealed.keyId,
        ],
      );
      if (changed.length !== 1) throw new ProductMfaConflict();
      const codes = await this.#replaceRecoveryCodes(tx, actor.userId);
      const session = await this.#continueSession(tx, secret, true, true);
      await this.identity.audit(tx, actor.userId, 'identity.mfa-enroll');
      return { session, recoveryCodes: codes };
    });
  }

  /**
   * Step-up by TOTP or one recovery code: the session continues as a fresh copy. A wrong proof is
   * counted and audited in one commit (with the trigger ending sessions from the tenth in a row
   * on) before the generic authentication failure is thrown.
   */
  async verify(secret: string, proof: ProductMfaProof, clientKey: string): Promise<ProductSession> {
    await this.#limit(secret, clientKey);
    const outcome = await this.identity.transactions.run('revoke', async (tx) => {
      const actor = await this.identity.authenticate(tx, secret);
      await this.#lockAccount(tx, actor.userId);
      const row = await this.#factor(tx, actor.userId);
      if (!row?.confirmed) throw new ProductMfaConflict();
      let accepted = false;
      if ('code' in proof) {
        const step = this.#match(actor.userId, row, proof.code);
        if (
          step !== undefined &&
          (row.last_used_step === null || step > BigInt(row.last_used_step))
        ) {
          // Every UPDATE of a confirmed factor other than a failure resets the counter (mfa_epoch).
          const sealed = this.#resealed(actor.userId, row);
          const changed = await tx.manager.query<unknown[]>(
            `WITH changed AS (UPDATE mfa_totp SET last_used_step=$2,failed_attempts=0,secret_ciphertext=$3,nonce=$4,key_id=$5
               WHERE user_id=$1 AND confirmed_at IS NOT NULL AND (last_used_step IS NULL OR last_used_step<$2) RETURNING 1) SELECT * FROM changed`,
            [actor.userId, step.toString(), sealed.ciphertext, sealed.nonce, sealed.keyId],
          );
          accepted = changed.length === 1;
        }
      } else {
        const normalized = normalizeRecoveryCode(proof.recoveryCode);
        if (normalized !== undefined) {
          const used = await tx.manager.query<unknown[]>(
            `WITH used AS (UPDATE mfa_recovery_code SET used_at=statement_timestamp()
               WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING 1) SELECT * FROM used`,
            [actor.userId, recoveryCodeHash(actor.userId, normalized)],
          );
          accepted = used.length === 1;
          if (accepted)
            await tx.manager.query('UPDATE mfa_totp SET failed_attempts=0 WHERE user_id=$1', [
              actor.userId,
            ]);
        }
      }
      if (!accepted) {
        const [counted] = await tx.manager.query<{ failed: number }[]>(
          'WITH counted AS (UPDATE mfa_totp SET failed_attempts=LEAST(failed_attempts+1,1000) WHERE user_id=$1 RETURNING failed_attempts) SELECT failed_attempts failed FROM counted',
          [actor.userId],
        );
        // Counter and event commit together before the 401; no proof is recorded.
        await this.identity.audit(tx, actor.userId, 'identity.mfa-verify-failed');
        if ((counted?.failed ?? 0) >= 10) {
          // The trigger advanced auth_epoch; revoke the rows too, as other epoch changes do.
          await this.identity.invalidate(tx, actor.userId);
          await this.identity.audit(tx, actor.userId, 'identity.mfa-lockout');
        }
        return { accepted: false } as const;
      }
      const session = await this.#continueSession(tx, secret, true, false);
      await this.identity.audit(
        tx,
        actor.userId,
        'code' in proof ? 'identity.mfa-verify' : 'identity.mfa-recovery',
      );
      return { accepted: true, session } as const;
    });
    if (!outcome.accepted) throw new ProductAuthenticationError();
    return outcome.session;
  }

  /** New set of ten codes; the old set is void. Needs a step-up. */
  async regenerateRecoveryCodes(secret: string, clientKey: string): Promise<readonly string[]> {
    await this.#limit(secret, clientKey);
    return this.identity.transactions.run('revoke', async (tx) => {
      const actor = await this.identity.authenticate(tx, secret);
      if (!actor.fresh) throw new ProductStepUpRequired();
      await this.#lockAccount(tx, actor.userId);
      if (!(await hasConfirmedSecondFactor(tx, actor.userId))) throw new ProductMfaConflict();
      const codes = await this.#replaceRecoveryCodes(tx, actor.userId);
      await this.identity.audit(tx, actor.userId, 'identity.mfa-recovery-regenerate');
      return codes;
    });
  }

  /** Removes factor and codes (the trigger ends every session); the caller continues, not fresh. */
  async remove(secret: string, clientKey: string): Promise<ProductSession> {
    await this.#limit(secret, clientKey);
    return this.identity.transactions.run('revoke', async (tx) => {
      const actor = await this.identity.authenticate(tx, secret);
      if (!actor.fresh) throw new ProductStepUpRequired();
      await this.#lockAccount(tx, actor.userId);
      await tx.manager.query('DELETE FROM mfa_recovery_code WHERE user_id=$1', [actor.userId]);
      const removed = await tx.manager.query<unknown[]>(
        'WITH removed AS (DELETE FROM mfa_totp WHERE user_id=$1 AND confirmed_at IS NOT NULL RETURNING 1) SELECT * FROM removed',
        [actor.userId],
      );
      if (removed.length !== 1) throw new ProductMfaConflict();
      const session = await this.#continueSession(tx, secret, false, true);
      await this.identity.audit(tx, actor.userId, 'identity.mfa-remove');
      return session;
    });
  }

  /** Rate limit per client and per account before any fenced work (purpose `mfa`). */
  async #limit(secret: string, clientKey: string): Promise<void> {
    const actor = await this.identity.transactions.run('identity', (tx) =>
      this.identity.authenticate(tx, secret),
    );
    await this.identity.rateLimit(clientKey, actor.userId, 'mfa');
  }

  /** Locks the account row (serializes every second-factor change); returns its email. */
  async #lockAccount(tx: ProductTransaction, userId: string): Promise<string | null> {
    const [row] = await tx.manager.query<{ email: string | null }[]>(
      'SELECT email_canonical email FROM app_user WHERE id=$1 FOR NO KEY UPDATE',
      [userId],
    );
    if (!row) throw new ProductAuthenticationError();
    return row.email;
  }

  async #factor(tx: ProductTransaction, userId: string): Promise<FactorRow | undefined> {
    const [row] = await tx.manager.query<FactorRow[]>(
      `SELECT secret_ciphertext,nonce,key_id,secret_version::text,confirmed_at IS NOT NULL confirmed,last_used_step::text,
         created_at>statement_timestamp()-make_interval(mins=>$2) live,
         floor(extract(epoch FROM statement_timestamp())/30)::bigint::text step
       FROM mfa_totp WHERE user_id=$1 FOR UPDATE`,
      [userId, SETUP_MINUTES],
    );
    return row;
  }

  /** The matched step, or undefined; a secret that cannot be opened is a server fault. */
  #match(userId: string, row: FactorRow, code: string): bigint | undefined {
    const raw = decryptTotpSecret(this.keys, userId, this.#sealed(row));
    try {
      return matchTotp(raw, code, BigInt(row.step));
    } finally {
      raw.fill(0);
    }
  }

  /** The row's secret under the current key: unchanged if already current. */
  #resealed(userId: string, row: FactorRow): SealedTotpSecret {
    if (row.key_id === this.keys.current) return this.#sealed(row);
    const raw = decryptTotpSecret(this.keys, userId, this.#sealed(row));
    try {
      return encryptTotpSecret(this.keys, userId, raw);
    } finally {
      raw.fill(0);
    }
  }

  #sealed(row: FactorRow): SealedTotpSecret {
    return { ciphertext: row.secret_ciphertext, nonce: row.nonce, keyId: row.key_id };
  }

  async #replaceRecoveryCodes(tx: ProductTransaction, userId: string): Promise<readonly string[]> {
    await tx.manager.query('DELETE FROM mfa_recovery_code WHERE user_id=$1', [userId]);
    const codes = Array.from({ length: RECOVERY_CODES }, () => newRecoveryCode());
    await tx.manager.query(
      'INSERT INTO mfa_recovery_code(user_id,code_hash) SELECT $1,unnest($2::bytea[])',
      [userId, codes.map((code) => recoveryCodeHash(userId, code))],
    );
    return codes.map(formatRecoveryCode);
  }

  /**
   * The caller's session continues as a new row copied from the current one: same
   * method, binding and provider versions, assurance, authentication time and absolute
   * deadline; only `reauthenticated_at` and the account's current `auth_epoch` are new. `everyone`
   * revokes every session of the account (after an epoch change), else only the current one.
   */
  async #continueSession(
    tx: ProductTransaction,
    secret: string,
    fresh: boolean,
    everyone: boolean,
  ): Promise<ProductSession> {
    const digest = sessionDigest(secret);
    const [current] = await tx.manager.query<{ user_id: string }[]>(
      'SELECT user_id FROM application_session WHERE token_hash=$1 AND revoked_at IS NULL',
      [digest],
    );
    if (!current) throw new ProductAuthenticationError();
    if (everyone) await this.identity.invalidate(tx, current.user_id);
    else
      await tx.manager.query(
        'UPDATE application_session SET revoked_at=statement_timestamp() WHERE token_hash=$1',
        [digest],
      );
    const next = newSessionSecret();
    const rows = await tx.manager.query<{ expires_at: string; max_age: number }[]>(
      `INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,reauthenticated_at,expires_at)
       SELECT $2,s.user_id,u.auth_epoch,s.method,s.assurance,s.external_issuer,s.external_subject,s.binding_version,s.provider_version,s.authenticated_at,
         CASE WHEN $3 THEN statement_timestamp() END,s.expires_at
       FROM application_session s JOIN app_user u ON u.id=s.user_id WHERE s.token_hash=$1
       RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
         GREATEST(0,floor(extract(epoch FROM expires_at-statement_timestamp())))::int AS max_age`,
      [digest, sessionDigest(next), fresh],
    );
    const row = rows[0];
    if (!row || !Number.isSafeInteger(row.max_age)) throw new ProductAuthenticationError();
    return { secret: next, expiresAt: row.expires_at, maxAge: row.max_age };
  }
}

export interface ProductMfaResetInput {
  readonly operationId: string;
  readonly userId: string;
  /** Reference of the independent approval record; never a secret. */
  readonly approval: string;
  readonly reason: string;
}

/**
 * Offline capability only: removes the second factor and recovery codes of one
 * account that lost both, with approval and audit. `identity` resets IAM accounts only and
 * `bootstrap` the Root only; the DB allows bootstrap no other target (protect_mfa_*), while
 * "identity never resets Root" is this code's check alone, since the identity credential can
 * already write any session (migration 008). No factor → nothing changes.
 */
export async function resetProductMfa(
  runner: ProductTransactionRunner,
  audit: ProductAuditRepository,
  input: ProductMfaResetInput,
  core: { isCanonicalUuid(value: unknown): boolean },
  login: 'identity' | 'bootstrap',
): Promise<{ reset: boolean }> {
  const printable = (value: unknown, max: number) =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/\p{Cc}/u.test(value);

  if (
    !core.isCanonicalUuid(input.operationId) ||
    !core.isCanonicalUuid(input.userId) ||
    input.userId === PRODUCT_OFFLINE_ACTOR ||
    !printable(input.approval, 200) ||
    !printable(input.reason, 1000)
  )
    throw new TypeError('Invalid second factor reset input');
  return runner.run(login === 'bootstrap' ? 'bootstrap' : 'revoke', async (tx) => {
    const [target] = await tx.manager.query<{ kind: string }[]>(
      'SELECT kind FROM app_user WHERE id=$1 FOR NO KEY UPDATE',
      [input.userId],
    );
    if (target?.kind !== (login === 'bootstrap' ? 'root' : 'iam'))
      throw new TypeError(
        login === 'bootstrap'
          ? 'Root second factors only: reset IAM accounts with identity:reset-mfa'
          : 'IAM second factors only: reset the Root with root:reset-mfa',
      );
    await tx.manager.query('DELETE FROM mfa_recovery_code WHERE user_id=$1', [input.userId]);
    const removed = await tx.manager.query<unknown[]>(
      'WITH removed AS (DELETE FROM mfa_totp WHERE user_id=$1 RETURNING 1) SELECT * FROM removed',
      [input.userId],
    );
    if (!removed.length) return { reset: false };
    await audit.appendProductAudit(tx, {
      kind: 'identity.mfa-reset',
      actor: PRODUCT_OFFLINE_ACTOR,
      target: { userId: input.userId },
      operationId: input.operationId,
      approval: input.approval,
      reason: input.reason,
    });
    return { reset: true };
  });
}

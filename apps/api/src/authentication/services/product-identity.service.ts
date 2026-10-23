import { createHash, randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type {
  ProductTransaction,
  ProductTransactionRunner,
} from '../../database/product-transaction.runner.js';
import {
  type ProductAuditRepository,
  PRODUCT_OFFLINE_ACTOR,
  type ProductIdentityAuditKind,
} from '../../audit/product-audit.repository.js';

export class ProductAuthenticationError extends Error {
  constructor() {
    super('Authentication failed');
  }
}

const RATE_LIMIT_ROWS = 10_000;
const RATE_LIMIT_LOCK = 1379171467;

/**
 * Limiter client key. One IPv6 /64 is one client (a host usually owns the whole prefix); IPv6
 * forms that carry an IPv4 client (mapped ::ffff:0:0/96, compatible ::/96, NAT64 64:ff9b::/96)
 * are that IPv4 address. A port (`a.b.c.d:p`, `[v6]:p`) is dropped. Other values stay as given.
 */
export function rateLimitClient(address: string): string {
  const bare =
    /^\[([^\]]+)\](?::\d+)?$/.exec(address)?.[1] ??
    /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(address)?.[1] ??
    address;
  const ip = bare.split('%')[0]!;
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return address;

  const words = (part: string): number[] =>
    part
      ? part.split(':').flatMap((g) => {
          if (!g.includes('.')) return [parseInt(g, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = g.split('.').map(Number);
          return [a * 256 + b, c * 256 + d];
        })
      : [];

  const [head = '', tail] = ip.split('::');
  const left = words(head);
  const right = tail === undefined ? [] : words(tail);
  const w = [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];

  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);

  if (
    (zero(0, 5) && (w[5] === 0xffff || (w[5] === 0 && w[6] !== 0))) ||
    (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6))
  )
    return `${w[6]! >> 8}.${w[6]! & 255}.${w[7]! >> 8}.${w[7]! & 255}`;
  return `${w
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

/**
 * Fresh reauthentication: in the past and less than 300 seconds before the statement time.
 * Evaluated in SQL so the DB clock and microseconds decide (spec 6.4, ADR 0022); authorization
 * and identity (second factor management) share this one condition.
 */
export const PRODUCT_FRESH_AUTH_SQL =
  "(reauthenticated_at IS NOT NULL AND reauthenticated_at<=statement_timestamp() AND statement_timestamp()-reauthenticated_at<interval '300 seconds')";

/**
 * True when the account has a confirmed second factor (ADR 0026 §9). Since ADR 0027 the factor is
 * the only source of `fresh`; any future step-up source must refuse accounts for which this holds.
 */
export async function hasConfirmedSecondFactor(
  tx: ProductTransaction,
  userId: string,
): Promise<boolean> {
  const rows = await tx.manager.query<unknown[]>(
    'SELECT 1 FROM mfa_totp WHERE user_id=$1 AND confirmed_at IS NOT NULL',
    [userId],
  );
  return rows.length > 0;
}

/** A new session. Both times come from the DB statement that created it (ADR 0022 §3). */
export interface ProductSession {
  secret: string;
  /** Absolute expiry, ISO-8601 UTC with milliseconds and `Z`. */
  expiresAt: string;
  /** Whole seconds left until `expiresAt`, for the cookie `Max-Age`. */
  maxAge: number;
}

export interface ProductSessionIdentity {
  userId: string;
  authEpoch: string;
  /** Google OIDC only since migration 018 (ADR 0027 §2). */
  method: 'oidc';
  assurance: string;
  authenticatedAt: Date;
  /** PRODUCT_FRESH_AUTH_SQL of the session, by the DB clock of the resolving statement. */
  fresh: boolean;
}

export function canonicalLoginEmail(email: string): string {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
    throw new ProductAuthenticationError();
  return email.toLowerCase();
}

export function newSessionSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function secretDigest(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function sessionDigest(secret: string): Buffer {
  if (
    typeof secret !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(secret) ||
    Buffer.from(secret, 'base64url').toString('base64url') !== secret
  )
    throw new ProductAuthenticationError();
  return secretDigest(secret);
}

interface SessionRow {
  user_id: string;
  auth_epoch: string;
  method: 'oidc';
  assurance: string;
  authenticated_at: Date;
  fresh: boolean;
}

/**
 * Offline maintenance: deletes at most `batchSize` sessions whose absolute expiry passed more than
 * `retentionDays` ago, in one short identity transaction with its audit event. Rows locked by live
 * identity transactions (logout, reset) are skipped, never waited for. Expired sessions grant
 * nothing, so the purge has no authority effect; retention is the deployment's decision.
 */
export async function purgeExpiredSessions(
  transactions: ProductTransactionRunner,
  audit: ProductAuditRepository,
  retentionDays: number,
  batchSize: number,
): Promise<number> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650)
    throw new RangeError('retentionDays must be an integer 0-3650');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new RangeError('batchSize must be an integer 1-1000');
  return transactions.run('identity', async (tx) => {
    const [purged] = await tx.manager.query<{ n: number }[]>(
      `WITH purged AS (DELETE FROM application_session WHERE token_hash IN (
        SELECT token_hash FROM application_session WHERE expires_at<=statement_timestamp()-make_interval(days=>$1)
        ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING 1)
      SELECT count(*)::int n FROM purged`,
      [retentionDays, batchSize],
    );
    const deleted = purged?.n ?? 0;
    if (deleted > 0)
      await audit.appendProductAudit(tx, {
        kind: 'identity.session-purge',
        actor: PRODUCT_OFFLINE_ACTOR,
        deleted: String(deleted),
        retentionDays: String(retentionDays),
      });
    return deleted;
  });
}

/**
 * Sessions, rate limiting and OIDC activation proofs (ADR 0027: Google is the only sign-in; no
 * password is stored, checked or reset here).
 */
export class ProductIdentityService {
  constructor(
    readonly transactions: ProductTransactionRunner,
    private readonly auditRepository: ProductAuditRepository,
  ) {}

  audit(tx: ProductTransaction, userId: string, kind: ProductIdentityAuditKind): Promise<void> {
    return this.auditRepository.appendProductAudit(tx, { kind, actor: userId });
  }

  async rateLimit(clientKey: string, identifier: string, purpose: string): Promise<void> {
    if (typeof clientKey !== 'string' || clientKey.length < 1 || clientKey.length > 256)
      throw new ProductAuthenticationError();
    const client = rateLimitClient(clientKey);
    const network = client.endsWith('::/64')
      ? `${client.split(':').slice(0, 3).join(':')}::/48`
      : undefined;
    // One bounded database limiter shared by replicas, serialized by one advisory key taken before
    // the fence (queued logins must not hold the fence against revokes); expired rows never accumulate.
    const allowed = await this.transactions.run(
      'identity',
      async (tx) => {
        await tx.manager.query(
          `DELETE FROM rate_limit WHERE window_start <= statement_timestamp()-interval '15 minutes'`,
        );
        // A full table evicts instead of denying every client: the fewest attempts go first, so
        // clearing a bucket at n attempts needs ~10k buckets at >=n attempts. A /64 is one client
        // and a /48 shares 200 attempts across all purposes (~20 such client/identifier buckets per
        // /48), so one routed IPv6 prefix cannot supply them.
        // ponytail: ~500 /48s or ~1000 IPv4 hosts can still clear old buckets; add ingress quotas if that matters.
        await tx.manager.query(
          `DELETE FROM rate_limit WHERE bucket_key IN (SELECT bucket_key FROM rate_limit ORDER BY attempts,window_start,bucket_key
          LIMIT GREATEST((SELECT count(*) FROM rate_limit)-$1,0))`,
          [RATE_LIMIT_ROWS - 3],
        );
        // Network, then client: a limited source stops early and cannot add identifier rows.
        const buckets: [string, number][] = [
          ...(network ? ([[`net:${network}`, 200]] as [string, number][]) : []),
          [`${purpose}:ip:${client}`, 20],
          ...(identifier === client
            ? []
            : ([[`${purpose}:login:${identifier}`, 20]] as [string, number][])),
        ];
        for (const [key, limit] of buckets) {
          const rows = await tx.manager.query<{ attempts: number }[]>(
            `INSERT INTO rate_limit(bucket_key,window_start,attempts) VALUES($1,statement_timestamp(),1)
          ON CONFLICT(bucket_key) DO UPDATE SET attempts=LEAST(rate_limit.attempts+1,1001) RETURNING attempts`,
            [secretDigest(key)],
          );
          if ((rows[0]?.attempts ?? 1001) > limit) return false;
        }
        return true;
      },
      { serialize: RATE_LIMIT_LOCK },
    );
    if (!allowed) throw new ProductAuthenticationError();
  }

  async createSession(
    tx: ProductTransaction,
    input: {
      userId: string;
      authEpoch: string;
      assurance: string;
      issuer: string;
      subject: string;
      bindingVersion: string;
      providerVersion: string;
      /** IdP `auth_time` in whole UTC seconds, already validated; absent → the statement time. */
      authTime?: number;
      reauthenticated?: boolean;
    },
  ): Promise<ProductSession> {
    const secret = newSessionSecret();
    // Expiry text and cookie lifetime come from this same statement's clock, never the API's.
    const rows = await tx.manager.query<{ expires_at: string; max_age: number }[]>(
      `INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,reauthenticated_at,expires_at)
      VALUES($1,$2,$3,'oidc',$4,$5,$6,$7,$10,COALESCE(to_timestamp($8::bigint),statement_timestamp()),CASE WHEN $9 THEN statement_timestamp() ELSE NULL END,statement_timestamp()+interval '12 hours')
      RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
        GREATEST(0,floor(extract(epoch FROM expires_at-statement_timestamp())))::int AS max_age`,
      [
        sessionDigest(secret),
        input.userId,
        input.authEpoch,
        input.assurance,
        input.issuer,
        input.subject,
        input.bindingVersion,
        input.authTime ?? null,
        input.reauthenticated ?? false,
        input.providerVersion,
      ],
    );
    const row = rows[0];
    if (!row || !Number.isSafeInteger(row.max_age)) throw new ProductAuthenticationError();
    return { secret, expiresAt: row.expires_at, maxAge: row.max_age };
  }

  async authenticate(tx: ProductTransaction, secret: string): Promise<ProductSessionIdentity> {
    const rows = await tx.manager.query<SessionRow[]>(
      `SELECT s.user_id,s.auth_epoch,s.method,s.assurance,s.authenticated_at,${PRODUCT_FRESH_AUTH_SQL} AS fresh FROM public.resolve_session($1) s`,
      [sessionDigest(secret)],
    );
    const row = rows[0];
    if (!row) throw new ProductAuthenticationError();
    // No rolling expiry: touching activity cannot extend the absolute deadline.
    if (tx.mode === 'identity' || tx.mode === 'revoke')
      await tx.manager.query(
        `UPDATE application_session SET last_seen_at=statement_timestamp() WHERE token_hash=$1`,
        [sessionDigest(secret)],
      );
    return {
      userId: row.user_id,
      authEpoch: row.auth_epoch,
      method: row.method,
      assurance: row.assurance,
      authenticatedAt: row.authenticated_at,
      fresh: row.fresh === true,
    };
  }

  async logout(secret: string, all = false): Promise<void> {
    await this.transactions.run('revoke', async (tx) => {
      const identity = await this.authenticate(tx, secret);
      if (all)
        await tx.manager.query(
          `UPDATE application_session SET revoked_at=statement_timestamp() WHERE user_id=$1 AND revoked_at IS NULL`,
          [identity.userId],
        );
      else
        await tx.manager.query(
          `UPDATE application_session SET revoked_at=statement_timestamp() WHERE token_hash=$1`,
          [sessionDigest(secret)],
        );
      await this.audit(tx, identity.userId, all ? 'identity.logout-all' : 'identity.logout');
    });
  }

  async invalidate(tx: ProductTransaction, userId: string): Promise<void> {
    await tx.manager.query(
      `UPDATE one_time_token SET consumed_at=statement_timestamp() WHERE user_id=$1 AND consumed_at IS NULL`,
      [userId],
    );
    await tx.manager.query(
      `UPDATE application_session SET revoked_at=statement_timestamp() WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
  }
}

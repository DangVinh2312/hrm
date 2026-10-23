import { randomUUID } from 'node:crypto';
import {
  ProductAuthenticationError,
  newSessionSecret,
  sessionDigest,
} from '../dist/authentication/services/product-identity.service.js';
import { ProductOidcService } from '../dist/authentication/services/product-oidc.service.js';
import { withClient } from './setup-postgres.ts';
import {
  issuer,
  postgres,
  pools,
  migration,
  runner,
  identity,
  responseFor,
} from './product-sign-in-stack.helper.ts';

export let clients = 0;

export const client = () => `methods-${++clients}`;

export const superuser = (sql: string, values: unknown[] = []) =>
  withClient(postgres.superuser, (c) => c.query(sql, values));

/** Active IAM account with a verified email unless told otherwise (bound by the caller). */
export async function account(options: { email?: string | null; verified?: boolean } = {}) {
  const id = randomUUID();
  const email = options.email === undefined ? `${id}@example.test` : options.email;
  await migration.query(
    `INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES($1,$2,$3,'active')`,
    [id, email, options.verified ?? true],
  );
  return { id, email: email ?? '' };
}

/** Binds (issuer, subject) as the identity login does (column grant); returns its reference. */
export async function bind(userId: string, at: string, subject: string): Promise<string> {
  const [row] = await pools.identity.query<{ ref: string }[]>(
    `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3) RETURNING binding_ref::text ref`,
    [at, subject, userId],
  );
  return row!.ref;
}

/** An OIDC session row for `userId` through an existing binding; fresh by default. */
export async function session(
  userId: string,
  options: { fresh?: boolean; oidc: { issuer: string; subject: string } },
): Promise<string> {
  const secret = newSessionSecret();
  const reauthenticated =
    options.fresh === false ? 'NULL' : "statement_timestamp()-interval '5 seconds'";
  await pools.identity.query(
    `INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,reauthenticated_at,expires_at)
       VALUES($1,$2,(SELECT auth_epoch FROM app_user WHERE id=$2),'oidc','oidc',$3,$4,
         (SELECT binding_version FROM external_identity WHERE issuer=$3 AND subject=$4),
         (SELECT version FROM oidc_provider WHERE issuer=$3),statement_timestamp(),${reauthenticated},statement_timestamp()+interval '1 hour')`,
    [sessionDigest(secret), userId, options.oidc.issuer, options.oidc.subject],
  );
  return secret;
}

export const live = (secret: string) =>
  runner
    .run('read', (tx) => identity.authenticate(tx, secret))
    .then(
      () => true,
      (error: unknown) => {
        if (error instanceof ProductAuthenticationError) return false;
        throw error;
      },
    );

export const verified = (sub: string, email: string) => ({ sub, email, email_verified: true });

export const bindings = (userId: string) =>
  migration.query<
    { issuer: string; subject: string; enabled: boolean; ref: string; version: string }[]
  >(
    `SELECT issuer,subject,enabled,binding_ref::text ref,binding_version::text version FROM external_identity WHERE user_id=$1 ORDER BY issuer,subject`,
    [userId],
  );

export const epoch = async (userId: string) =>
  (
    await migration.query<{ e: string }[]>('SELECT auth_epoch::text e FROM app_user WHERE id=$1', [
      userId,
    ])
  )[0]?.e;

export const emailState = async (userId: string) =>
  (
    await migration.query<{ email: string | null; verified: boolean }[]>(
      'SELECT email_canonical email,email_verified verified FROM app_user WHERE id=$1',
      [userId],
    )
  )[0];

/** begin(login) + callback with these ID token claims at `at`. */
export async function login(
  service: ProductOidcService,
  claims: Record<string, unknown>,
  at = issuer,
) {
  const browser = newSessionSecret();
  const start = await service.begin(at, browser, {}, client());
  return service.callback(at, responseFor(start, claims), browser);
}

/** The provider's error redirect (user cancelled): the attempt's state, `error`, no `code`. */
export function cancelledFor(url: URL): URL {
  const response = new URL(url.searchParams.get('redirect_uri') ?? '');
  response.searchParams.set('state', url.searchParams.get('state') ?? '');
  response.searchParams.set('error', 'access_denied');
  return response;
}

export const failure = (operation: Promise<unknown>) =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

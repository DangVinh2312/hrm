// Binding references and one Google binding per account (no link,
// unlink or Google step-up) against real PostgreSQL logins: migrations 014/015/017 grants,
// triggers and probes, and a signed RS256 fixture provider. The last test drives the remaining
// OIDC routes over HTTP through the real AppModule (in-process).
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import * as oidc from 'openid-client';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { ProductIdentityService } from '../dist/authentication/services/product-identity.service.js';
import type { ProductOidcProvider } from '../dist/authentication/services/product-oidc-provider.service.js';
import { ProductOidcService } from '../dist/authentication/services/product-oidc.service.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { startPostgres, type TestPostgres } from './setup-postgres.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

export const core = createProductAuthorizationCore();

export const release = createProductRelease(core);

/** Current at the DB and in the runtime configuration. */
export const issuer = 'https://issuer.fixture';

/** Second current provider. */
export const second = 'https://second.fixture';

/** Enabled in the DB at version 2, configured at version 1: never usable. */
export const stale = 'https://stale.fixture';

/** Configured, disabled in the DB. */
export const disabled = 'https://disabled.fixture';

export const redirectUri = 'https://app.fixture/api/auth/oidc/callback';

export let postgres: TestPostgres;

export let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;

export let migration: DataSource;

export let runner: ProductTransactionRunner;

export let identity: ProductIdentityService;

export let providers: Map<string, ProductOidcProvider>;

export let federation: ProductOidcService;

export let server: Server;

export let port = 0;

export const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'fixture-key',
  alg: 'RS256',
  use: 'sig',
};

export const codes = new Map<
  string,
  { issuer: string; nonce: string; challenge: string; claims: Record<string, unknown> }
>();

export function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  const input = `${part({ alg: 'RS256', kid: 'fixture-key' })}.${part(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}

/** The provider's redirect back to the app for an authorization URL `begin` returned. */
export function responseFor(url: URL, claims: Record<string, unknown>): URL {
  const code = randomBytes(16).toString('hex');
  codes.set(code, {
    issuer: url.origin,
    nonce: url.searchParams.get('nonce') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
    claims,
  });
  const response = new URL(url.searchParams.get('redirect_uri') ?? '');
  response.searchParams.set('state', url.searchParams.get('state') ?? '');
  response.searchParams.set('code', code);
  return response;
}

export function fixtureProvider(
  at: string,
  version: string,
  redirect = redirectUri,
): ProductOidcProvider {
  const configuration = new oidc.Configuration(
    {
      issuer: at,
      authorization_endpoint: `${at}/authorize`,
      token_endpoint: `${at}/token`,
      jwks_uri: `${at}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
    },
    'fixture-client',
    { id_token_signed_response_alg: 'RS256' },
    oidc.None(),
  );
  configuration[oidc.customFetch] = (input, init) =>
    fetch(`http://127.0.0.1:${port}${new URL(input).pathname}`, {
      ...init,
      body: init.body instanceof URLSearchParams ? init.body.toString() : init.body,
    } as RequestInit);
  return {
    settings: {
      issuer: at,
      clientId: 'fixture-client',
      redirectUri: redirect,
      version,
      assuranceMappings: [],
    },
    configuration,
  };
}

export async function setupStack(): Promise<void> {
  postgres = await startPostgres();
  const passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((p) => [
      p,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  const connections = await provisionProductDatabase(postgres.superuser, passwords);
  pools = {} as typeof pools;
  for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
  migration = await new DataSource(productDataSourceOptions(connections.migration)).initialize();
  runner = new ProductTransactionRunner(pools);
  identity = new ProductIdentityService(runner, audit);
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
  }).reconcile(release);
  for (const [at, version, enabled] of [
    [issuer, 1, true],
    [second, 1, true],
    [stale, 2, true],
    [disabled, 1, false],
  ] as const)
    await migration.query('INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,$2,$3)', [
      at,
      version,
      enabled,
    ]);
  server = createServer((req, res) => {
    (async () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/jwks') return void res.end(JSON.stringify({ keys: [jwk] }));
      if (req.url !== '/token') return void res.writeHead(404).end();
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const input = new URLSearchParams(body);
      const code = input.get('code') ?? '';
      const attempt = codes.get(code);
      if (
        !attempt ||
        createHash('sha256')
          .update(input.get('code_verifier') ?? '')
          .digest('base64url') !== attempt.challenge
      )
        return void res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
      codes.delete(code);
      const now = Math.floor(Date.now() / 1000);
      res.end(
        JSON.stringify({
          access_token: 'fixture-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: jwt({
            iss: attempt.issuer,
            aud: 'fixture-client',
            iat: now,
            exp: now + 300,
            auth_time: now,
            nonce: attempt.nonce,
            sub: 'default-subject',
            ...attempt.claims,
          }),
        }),
      );
    })().catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  providers = new Map(
    [issuer, second, stale, disabled].map((at) => [at, fixtureProvider(at, '1')] as const),
  );
  federation = new ProductOidcService(identity, providers);
}

export async function teardownStack(): Promise<void> {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
}

import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, generateKeyPairSync, createSign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import * as oidc from 'openid-client';
import { productDataSourceOptions } from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { ProductIdentityService } from '../dist/auth/services/product-identity.service.js';
import type { ProductOidcProvider } from '../dist/auth/services/product-oidc-provider.service.js';
import { ProductOidcService } from '../dist/auth/services/product-oidc.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { startPostgres, type TestPostgres } from './setup-postgres.ts';
import { bindAccount } from './oidc-fixture.helper.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

export let postgres: TestPostgres;

export let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;

export let fixtureAdmin: DataSource;

export let connections: Awaited<ReturnType<typeof provisionProductDatabase>>;

export let identity: ProductIdentityService;

export let runner: ProductTransactionRunner;

export let provider: ProductOidcProvider;

export let federation: ProductOidcService;

export let server: Server;

export const issuer = 'https://issuer.fixture';

export const redirectUri = 'https://app.fixture/oidc/callback';

export const subject = 'exact-subject';

export const userId = randomUUID();

export const core = createProductAuthorizationCore();

export const productRelease = createProductRelease(core);

export const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'fixture-key',
  alg: 'RS256',
  use: 'sig',
};

export const codes = new Map<
  string,
  { nonce: string; challenge: string; changes: Record<string, unknown>; badSignature: boolean }
>();

export let tokenGate: (() => Promise<void>) | undefined;

/** Imported bindings are read-only: tests install and clear the gate through this setter. */
export function setTokenGate(gate: (() => Promise<void>) | undefined): void {
  tokenGate = gate;
}

export function jwt(claims: Record<string, unknown>, badSignature: boolean): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${badSignature ? Buffer.alloc(256).toString('base64url') : signature}`;
}

export function responseFor(
  url: URL,
  changes: Record<string, unknown> = {},
  badSignature = false,
): URL {
  const code = randomBytes(16).toString('hex');
  codes.set(code, {
    nonce: url.searchParams.get('nonce')!,
    challenge: url.searchParams.get('code_challenge')!,
    changes,
    badSignature,
  });
  const response = new URL(redirectUri);
  response.searchParams.set('state', url.searchParams.get('state')!);
  response.searchParams.set('code', code);
  return response;
}

export async function setupStack(): Promise<void> {
  postgres = await startPostgres();
  const secrets = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((p) => [
      p,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<
    'data' | 'identity' | 'authority' | 'sync' | 'bootstrap' | 'migration' | 'outbox',
    string
  >;
  connections = await provisionProductDatabase(postgres.superuser, secrets);
  pools = {} as typeof pools;
  for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
  fixtureAdmin = await new DataSource(productDataSourceOptions(connections.migration)).initialize();
  runner = new ProductTransactionRunner(pools);
  identity = new ProductIdentityService(runner, audit);
  await fixtureAdmin.query(
    `INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES($1,'user@example.test',true,'active')`,
    [userId],
  );
  await fixtureAdmin.query(`INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)`, [
    issuer,
  ]);
  server = createServer((req, res) => {
    void (async () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/jwks') {
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (req.url !== '/token') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const input = new URLSearchParams(body);
      const code = input.get('code');
      const attempt = code ? codes.get(code) : undefined;
      if (
        !attempt ||
        createHash('sha256')
          .update(input.get('code_verifier') ?? '')
          .digest('base64url') !== attempt.challenge ||
        input.get('redirect_uri') !== redirectUri
      ) {
        res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      codes.delete(code!);
      await tokenGate?.();
      const now = Math.floor(Date.now() / 1000);
      res.end(
        JSON.stringify({
          access_token: 'fixture-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: jwt(
            {
              iss: issuer,
              sub: subject,
              aud: 'fixture-client',
              iat: now,
              exp: now + 300,
              auth_time: now,
              nonce: attempt.nonce,
              ...attempt.changes,
            },
            attempt.badSignature,
          ),
        }),
      );
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const configuration = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
    },
    'fixture-client',
    { id_token_signed_response_alg: 'RS256' },
    oidc.None(),
  );
  configuration[oidc.customFetch] = (input, init) => {
    const target = new URL(input);
    assert.equal(target.origin, issuer);
    return fetch(`http://127.0.0.1:${port}${target.pathname}`, {
      ...init,
      body:
        init.body instanceof URLSearchParams
          ? init.body.toString()
          : typeof init.body === 'string'
            ? init.body
            : init.body instanceof Uint8Array
              ? new TextDecoder().decode(init.body)
              : undefined,
    });
  };
  provider = {
    settings: {
      issuer,
      clientId: 'fixture-client',
      redirectUri,
      version: '1',
      assuranceMappings: [{ acr: 'urn:fixture:mfa', amr: ['pwd', 'otp'], assurance: 'mfa' }],
    },
    configuration,
  };
  federation = new ProductOidcService(identity, new Map([[issuer, provider]]));
}

export async function teardownStack(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  for (const source of Object.values(pools ?? {})) await source.destroy();
  await fixtureAdmin?.destroy();
  await postgres?.stop();
}

/** Active accounts, each with one Google binding at the fixture issuer; synthetic ids only. */
export async function activeOidcUsers(prefix: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    await pools.identity.query(
      "INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES($1,$2,true,'active')",
      [id, `${prefix}${i}-${id}@example.test`],
    );
    await bindAccount(pools.identity, id, `${prefix}-${id}`, issuer);
    ids.push(id);
  }
  return ids;
}

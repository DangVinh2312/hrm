// In-process OIDC provider for tests that drive `ProductOidcService` directly: a local HTTP server
// answers the token and JWKS requests the service sends, and `responseFor` plays the browser's
// redirect back with a code whose ID token carries the given claims (signed RS256, random key).
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as oidc from 'openid-client';
import type { ProductOidcProvider } from '../dist/auth/services/product-oidc.service.js';

export const IDP_REDIRECT_URI = 'https://app.fixture/api/auth/oidc/callback';

export interface FixtureIdp {
  /** The provider configuration for `issuer`, talking to this server. */
  provider(issuer: string, version?: string): ProductOidcProvider;

  /** The redirect back to the app for an authorization URL `begin` returned. */
  responseFor(url: URL, claims: Record<string, unknown>): URL;

  close(): Promise<void>;
}

export async function startFixtureIdp(): Promise<FixtureIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'fixture-key',
    alg: 'RS256',
    use: 'sig',
  };
  const codes = new Map<
    string,
    { issuer: string; nonce: string; challenge: string; claims: Record<string, unknown> }
  >();

  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  const jwt = (claims: Record<string, unknown>) => {
    const input = `${part({ alg: 'RS256', kid: 'fixture-key' })}.${part(claims)}`;
    return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
  };

  const server: Server = createServer((req, res) => {
    (async () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/jwks') return void res.end(JSON.stringify({ keys: [jwk] }));
      if (req.url !== '/token') return void res.writeHead(404).end();
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const input = new URLSearchParams(body);
      const code = input.get('code') ?? '';
      const attempt = codes.get(code);
      const challenge = createHash('sha256')
        .update(input.get('code_verifier') ?? '')
        .digest('base64url');
      if (!attempt || challenge !== attempt.challenge)
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
  const port = (server.address() as AddressInfo).port;
  return {
    provider(issuer, version = '1') {
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
      configuration[oidc.customFetch] = (input, init) =>
        fetch(`http://127.0.0.1:${port}${new URL(input).pathname}`, {
          ...init,
          body: init.body instanceof URLSearchParams ? init.body.toString() : init.body,
        } as RequestInit);
      return {
        settings: {
          issuer,
          clientId: 'fixture-client',
          redirectUri: IDP_REDIRECT_URI,
          version,
          assuranceMappings: [],
        },
        configuration,
      };
    },
    responseFor(url, claims) {
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
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

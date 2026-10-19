import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TestTls } from './tls.helper.ts';

interface PendingCode {
  readonly subject: string;
  readonly email: string | undefined;
  readonly nonce: string;
  readonly challenge: string;
  readonly redirectUri: string;
}

/**
 * Minimal OpenID provider for browser tests: discovery, authorize (auto-consents as `subject`),
 * PKCE-checked token endpoint with RS256 ID tokens, JWKS. Synthetic identities only.
 */
export class FakeOidcProvider {
  /** Who the next authorization request signs in as. */
  subject = 'nobody';
  /** Verified email claim of the next sign-in; `undefined` sends no email claims. */
  email: string | undefined;
  /** The next authorization request is cancelled by the user (error redirect, no code). */
  cancel = false;
  readonly clientId = 'hrm-e2e';
  #server: Server | undefined;
  #issuer = '';
  #redirectUri = '';
  readonly #codes = new Map<string, PendingCode>();
  readonly #key: KeyObject;
  readonly #jwk: Record<string, unknown>;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.#key = privateKey;
    this.#jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'RS256', use: 'sig' };
  }

  get issuer(): string {
    return this.#issuer;
  }

  async start(tls: TestTls, port: number, redirectUri: string): Promise<void> {
    this.#issuer = `https://localhost:${port}`;
    this.#redirectUri = redirectUri;
    this.#server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      this.#handle(req.method ?? 'GET', req.url ?? '/', req).then(
        ({ status, headers, body }) => res.writeHead(status, headers).end(body),
        () => res.writeHead(500).end(),
      );
    });
    await new Promise<void>((resolve) => this.#server!.listen(port, '127.0.0.1', resolve));
    if ((this.#server.address() as AddressInfo).port !== port) throw new Error('IdP port mismatch');
  }

  async stop(): Promise<void> {
    if (this.#server) await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
  }

  async #handle(method: string, rawUrl: string, body: AsyncIterable<unknown>) {
    const url = new URL(rawUrl, this.#issuer);

    const json = (value: unknown, status = 200) => ({
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });

    if (method === 'GET' && url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer: this.#issuer,
        authorization_endpoint: `${this.#issuer}/authorize`,
        token_endpoint: `${this.#issuer}/token`,
        jwks_uri: `${this.#issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      });
    if (method === 'GET' && url.pathname === '/jwks') return json({ keys: [this.#jwk] });
    if (method === 'GET' && url.pathname === '/authorize') {
      const q = url.searchParams;
      if (
        q.get('client_id') !== this.clientId ||
        q.get('redirect_uri') !== this.#redirectUri ||
        q.get('response_type') !== 'code' ||
        q.get('code_challenge_method') !== 'S256' ||
        !q.get('state') ||
        !q.get('nonce') ||
        !q.get('code_challenge')
      )
        return json({ error: 'invalid_request' }, 400);
      const back = new URL(this.#redirectUri);
      if (this.cancel) {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', q.get('state')!);
        back.searchParams.set('iss', this.#issuer);
        return { status: 302, headers: { location: back.href }, body: '' };
      }
      const code = randomBytes(24).toString('base64url');
      this.#codes.set(code, {
        subject: this.subject,
        email: this.email,
        nonce: q.get('nonce')!,
        challenge: q.get('code_challenge')!,
        redirectUri: this.#redirectUri,
      });
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state')!);
      back.searchParams.set('iss', this.#issuer);
      return { status: 302, headers: { location: back.href }, body: '' };
    }
    if (method === 'POST' && url.pathname === '/token') {
      let text = '';
      for await (const chunk of body) text += String(chunk);
      const form = new URLSearchParams(text);
      const code = form.get('code') ?? '';
      const pending = this.#codes.get(code);
      this.#codes.delete(code);
      if (
        !pending ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('client_id') !== this.clientId ||
        form.get('redirect_uri') !== pending.redirectUri ||
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url') !== pending.challenge
      )
        return json({ error: 'invalid_grant' }, 400);
      const now = Math.floor(Date.now() / 1000);
      return json({
        access_token: randomBytes(16).toString('base64url'),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: this.#jwt({
          iss: this.#issuer,
          sub: pending.subject,
          aud: this.clientId,
          iat: now,
          exp: now + 300,
          auth_time: now,
          nonce: pending.nonce,
          ...(pending.email ? { email: pending.email, email_verified: true } : {}),
        }),
      });
    }
    return json({ error: 'not_found' }, 404);
  }

  #jwt(claims: Record<string, unknown>): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

    const input = `${part({ alg: 'RS256', typ: 'JWT', kid: 'e2e' })}.${part(claims)}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), this.#key).toString('base64url')}`;
  }
}

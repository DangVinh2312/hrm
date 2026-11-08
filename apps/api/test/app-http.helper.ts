// The real AppModule (guard, controllers, facades) over a module stack's pools and runner, on a
// loopback port: what ProductRuntime.create composes, without the boot probes and manifest sync
// the stack already did.
import { createServer, type AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../dist/app.module.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import { ProductIdentityService } from '../dist/authentication/services/product-identity.service.js';
import { ProductOidcService } from '../dist/authentication/services/product-oidc.service.js';
import { createProductAuthorizationCore } from '../dist/authorization/product.manifest.js';
import { type AppConfig, loadConfig } from '../dist/config/app.config.js';
import { ProductRuntime } from '../dist/infrastructure/product-runtime.service.js';
import { cookieName, newCsrf } from '../dist/infrastructure/helpers/http-security.helper.js';
import { useJsonBody } from '../dist/infrastructure/helpers/input-validation.helper.js';
import type { ModuleStack } from './hrm-stack.helper.ts';

export interface AppHttp {
  readonly origin: string;
  readonly config: AppConfig;

  /** Session cookie (when given) plus a matching CSRF cookie/header and the exact Origin. */
  headers(secret?: string): Record<string, string>;

  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function startAppHttp(stack: ModuleStack): Promise<AppHttp> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ORIGIN: origin,
    MFA_ENCRYPTION_KEYS: 'fixture:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    MFA_ENCRYPTION_KEY_ID: 'fixture',
    OIDC_PROVIDERS_JSON: JSON.stringify([
      {
        issuer: 'https://idp.example.test',
        clientId: 'fixture-client',
        redirectUri: `${origin}/api/auth/oidc/callback`,
        version: '1',
        assuranceMappings: [],
      },
    ]),
    ...Object.fromEntries(
      (['data', 'identity', 'authority', 'sync'] as const).map((p) => [
        `PRODUCT_${p.toUpperCase()}_DATABASE_URL`,
        `postgres://product_${p}:unused@127.0.0.1:1/product`,
      ]),
    ),
  });
  const audit = new ProductAuditRepository();
  const identity = new ProductIdentityService(stack.runner, audit);
  const Runtime = ProductRuntime as unknown as new (...args: unknown[]) => ProductRuntime;
  const runtime = new Runtime(
    config,
    createProductAuthorizationCore(),
    stack.pools,
    stack.runner,
    audit,
    identity,
    new ProductOidcService(identity, new Map()),
  );
  Object.assign(runtime, {
    onApplicationBootstrap: () => Promise.resolve(runtime.readiness.markReady()),
    onApplicationShutdown: () => Promise.resolve(),
  });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(runtime), {
    logger: false,
    abortOnError: false,
  });
  useJsonBody(app);
  await app.listen(port, '127.0.0.1');
  const csrf = newCsrf();
  return {
    origin,
    config,
    headers: (secret) => ({
      cookie: [
        ...(secret === undefined ? [] : [`${cookieName(config, 'session')}=${secret}`]),
        `${cookieName(config, 'csrf')}=${csrf}`,
      ].join('; '),
      origin,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    }),
    stop: () => app.close(),
  };
}

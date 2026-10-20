import { API_ERROR_CODES, apiErrorCode } from '../infrastructure/api-error.helper.js';
import { hrOpenApiPaths } from './hr-openapi.schema.js';

/**
 * Error body: `code` is a web locale key chosen from the status alone, or for 409/422 one of the
 * closed business rejection keys a route names (api-error.helper.ts).
 */
const error = (status: number, description: string, example = apiErrorCode(status)) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['statusCode', 'code'],
        properties: {
          statusCode: { type: 'integer' },
          code: { type: 'string', enum: [...API_ERROR_CODES] },
        },
      },
      example: { statusCode: status, code: example },
    },
  },
});

/** Contract for the deliberately small API. DTO validation uses the same field allowlists in handlers. */
const errors = {
  400: error(400, 'Invalid DTO or cookie'),
  401: error(401, 'Authentication failed'),
  403: error(403, 'CSRF, permission, policy, boundary or invariant denied'),
  404: error(404, 'Absent or hidden record'),
  409: error(409, 'Bounded concurrency conflict'),
  503: error(503, 'Authority or required capability unavailable'),
};

const fields = (names: readonly string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: names,
  properties: Object.fromEntries(
    names.map((name) => [
      name,
      {
        type: 'string',
        maxLength: 2048,
        example:
          name === 'email'
            ? 'person@example.test'
            : name === 'issuer'
              ? 'https://idp.example.test'
              : name === 'title'
                ? 'Revised title'
                : 'synthetic-one-time-proof',
      },
    ]),
  ),
});

const operation = (
  description: string,
  example: unknown,
  body: readonly string[] = [],
  authenticated = false,
) => ({
  summary: description,
  ...(authenticated ? { security: [{ sessionCookie: [] }] } : {}),
  ...(body.length
    ? { requestBody: { required: true, content: { 'application/json': { schema: fields(body) } } } }
    : {}),
  responses: {
    200: { description: 'Success', content: { 'application/json': { example } } },
    ...errors,
  },
});

const post = (summary: string, example: unknown, body: readonly string[], auth = false) => ({
  post: operation(summary, example, body, auth),
});

/** 422 only where a route names its rules (never in `operation`'s default set). */
const routeErrors = {
  ...errors,
  422: error(
    422,
    'A business rule of the request refused it; `code` names the rule (see the route)',
    'error.dateOutOfRange',
  ),
};

/** Only the statuses the route can actually return (ADR 0020 routes). */
const only = (statuses: readonly (keyof typeof routeErrors)[]) =>
  Object.fromEntries(statuses.map((status) => [status, routeErrors[status]]));

const bindingReference = '0b6f2d1e-8c4a-4f7b-9d3e-2a5c7e9f1b40';

/** ADR 0026 §8: exactly six ASCII digits; a recovery code as shown (case, hyphens, spaces ignored). */
const totpCode = { type: 'string', pattern: '^[0-9]{6}$', example: '123456' };
const recoveryCode = {
  type: 'string',
  maxLength: 64,
  pattern: '^[A-Za-z2-7 -]+$',
  example: 'ABCD-EFGH-IJKL-MNOP',
};

const exactly = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const recoveryCodesExample = Array.from({ length: 10 }, () => 'ABCD-EFGH-IJKL-MNOP');

/** Second factor routes: session cookie + CSRF; 403 is also a missing step-up where noted. */
const mfa = (
  summary: string,
  example: unknown,
  statuses: readonly (keyof typeof errors)[],
  body?: unknown,
) => ({
  summary,
  security: [{ sessionCookie: [] }],
  ...(body
    ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } }
    : {}),
  responses: {
    200: { description: 'Success', content: { 'application/json': { example } } },
    ...only(statuses),
  },
});

const accountExample = {
  userId: '5f0c2a9e-1b7d-4c3a-9e84-3d6b2f1a7c10',
  email: 'person@example.test',
  state: 'pending',
};

export const productOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Single product authorization API', version: '1' },
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-authz_session',
        description:
          'Development HTTP uses authz_session. All mutations also require exact Origin and x-csrf-token matching the CSRF cookie.',
      },
    },
  },
  paths: {
    '/api/health/live': { get: operation('Process liveness', { status: 'ok' }) },
    '/api/health/ready': {
      get: operation('Readiness after privilege checks and manifest sync', { status: 'ready' }),
    },
    '/api/health/metrics': {
      get: operation('Bounded transaction metric histograms', [
        { metric: 'lock_wait', mode: 'read', count: 1, sum: 5, buckets: [{ upper: 10, count: 1 }] },
      ]),
    },
    '/api/openapi.json': { get: operation('This API contract', { openapi: '3.1.0' }) },
    '/api/auth/options': {
      get: operation('Enabled sign-in methods (no provider or account data); Google OIDC only', {
        methods: ['oidc'],
      }),
    },
    '/api/auth/csrf': {
      get: operation('Issue a CSRF cookie and header token', { csrfToken: 'synthetic-csrf-token' }),
    },
    '/api/auth/session': {
      get: operation(
        'Current verified session projection',
        {
          userId: '5f0c2a9e-1b7d-4c3a-9e84-3d6b2f1a7c10',
          method: 'oidc',
          assurance: 'oidc',
          menus: ['accounts'],
        },
        [],
        true,
      ),
    },
    '/api/auth/account': {
      get: operation(
        "The caller's own email and sign-in methods: the enabled binding at an enabled provider (one per account) by reference, never the provider subject; nothing is removable (ADR 0027)",
        {
          email: 'person@example.test',
          identities: [{ issuer: 'https://idp.example.test', reference: bindingReference }],
          mfa: { status: 'enabled', recoveryCodesRemaining: 10 },
        },
        [],
        true,
      ),
    },
    '/api/auth/mfa/totp/setup': {
      post: mfa(
        'Start TOTP enrollment (ADR 0026): a new unconfirmed secret, replacing an earlier setup; the secret is returned only here. 409 once a factor is confirmed',
        {
          uri: 'otpauth://totp/HRM:person%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=HRM&algorithm=SHA1&digits=6&period=30',
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        },
        [400, 401, 403, 409, 503],
      ),
    },
    '/api/auth/mfa/totp/confirm': {
      post: mfa(
        'Confirm the setup (within 15 minutes) with a code: ends every other session, rotates this one as fresh and returns ten one-time recovery codes once. 409 without a live setup',
        { expiresAt: '2026-10-14T00:00:00.000Z', recoveryCodes: recoveryCodesExample },
        [400, 401, 403, 409, 503],
        exactly({ code: totpCode }),
      ),
    },
    '/api/auth/mfa/verify': {
      post: mfa(
        'Step-up by TOTP code or one recovery code: the session continues fresh with the same deadline. Wrong proofs are counted; the tenth in a row and every later one end all sessions. 409 without a confirmed factor',
        { expiresAt: '2026-10-14T00:00:00.000Z' },
        [400, 401, 403, 409, 503],
        { oneOf: [exactly({ code: totpCode }), exactly({ recoveryCode })] },
      ),
    },
    '/api/auth/mfa/recovery-codes': {
      post: mfa(
        'Replace the recovery codes; needs a step-up within 300 s (403 otherwise). The new codes are returned once',
        { recoveryCodes: recoveryCodesExample },
        [400, 401, 403, 409, 503],
      ),
    },
    '/api/auth/mfa/totp': {
      delete: mfa(
        'Remove the second factor and its recovery codes; needs a step-up within 300 s (403 otherwise); ends every session and continues this one, not fresh',
        { expiresAt: '2026-10-14T00:00:00.000Z' },
        [401, 403, 409, 503],
      ),
    },
    '/api/auth/logout': post('Revoke current application session', { status: 'revoked' }, [], true),
    '/api/auth/logout-all': post(
      'Revoke all current application sessions',
      { status: 'revoked' },
      [],
      true,
    ),
    '/api/auth/oidc/begin': post(
      'Begin allowlisted OIDC Code+PKCE login (scope openid email profile; only email/email_verified are used); a first login binds an email-enrolled pending account when the verified email matches',
      { authorizationUrl: 'https://idp.example.test/authorize' },
      ['issuer'],
    ),
    '/api/auth/oidc/activate': post(
      'Begin activation of a pending account with its offline one-time invitation; the IdP proof must be the exact pre-bound subject',
      { authorizationUrl: 'https://idp.example.test/authorize' },
      ['issuer', 'token'],
    ),
    '/api/auth/oidc/callback': {
      get: {
        summary: 'Consume browser-bound OIDC attempt and return the browser to the app',
        responses: {
          303: {
            description:
              'Fixed same-origin redirect: "/" after login or activation; "/login?error=oidc" when authentication fails or is cancelled at the provider, including an unknown or expired attempt. A login never makes the session fresh (ADR 0027 §7)',
            headers: {
              Location: {
                schema: {
                  type: 'string',
                  enum: ['/', '/login?error=oidc'],
                },
              },
            },
          },
          400: errors[400],
          503: errors[503],
        },
        parameters: [
          { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'iss', in: 'query', required: false, schema: { type: 'string' } },
        ],
      },
    },
    '/api/documents': {
      get: operation(
        'Scoped list before pagination with allowed projection',
        {
          items: [
            { key: '00000000-0000-4000-8000-000000000002', title: 'Visible draft', state: 'draft' },
          ],
          total: '1',
        },
        [],
        true,
      ),
    },
    '/api/documents/{id}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      get: operation(
        'Scoped detail; hidden and absent return identical404',
        { key: '00000000-0000-4000-8000-000000000002', title: 'Visible draft', state: 'draft' },
        [],
        true,
      ),
      patch: operation('Update title of authorized draft', { status: 'updated' }, ['title'], true),
    },
    '/api/administration/accounts': {
      post: {
        summary:
          'Add an email for Google first login: a pending IAM account with a 7-day enrollment (Root, or a grant within a required boundary; fresh reauthentication)',
        security: [{ sessionCookie: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['email'],
                properties: {
                  email: {
                    type: 'string',
                    format: 'email',
                    maxLength: 254,
                    example: 'person@example.test',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Pending account created',
            content: { 'application/json': { example: accountExample } },
          },
          ...only([400, 401, 403, 409, 503]),
        },
      },
      get: {
        summary: 'IAM accounts with email, state and enrollment status, ordered by email',
        security: [{ sessionCookie: [] }],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
          },
        ],
        responses: {
          200: {
            description: 'Success',
            content: {
              'application/json': {
                example: { items: [{ ...accountExample, enrollment: 'pending' }], total: '1' },
              },
            },
          },
          ...only([400, 401, 403, 503]),
        },
      },
    },
    '/api/administration/users/{id}/suspend': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      ...post(
        'Suspend an IAM user: Root, or a grant within a required boundary',
        { status: 'suspended' },
        [],
        true,
      ),
    },
    ...hrOpenApiPaths(only),
  },
};

import { z } from 'zod';
import type { HttpClient } from '../../infrastructure/http.client';

/**
 * `GET /api/auth/account`: the Google binding by reference, never the provider
 * subject, and nothing removable; the second factor by status and remaining
 * recovery codes only. Strict: a body that carried anything more about the factor
 * breaks the contract.
 */
const accountSchema = z.object({
  email: z.string().max(320).nullable(),
  identities: z.array(z.object({ issuer: z.string().max(2048), reference: z.uuid() })).max(16),
  mfa: z.strictObject({
    status: z.enum(['none', 'pending', 'enabled']),
    recoveryCodesRemaining: z.number().int().min(0).max(10),
  }),
});
export type OwnAccount = z.infer<typeof accountSchema>;

export type LinkedIdentity = OwnAccount['identities'][number];

const sessionSchema = z.object({ expiresAt: z.iso.datetime() });

function uriSecret(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get('secret');
  } catch {
    return null;
  }
}

/** The authenticator URI carries the same base32 secret the page shows as text. */
const setupSchema = z
  .object({
    uri: z.string().max(2048).startsWith('otpauth://totp/HRM'),
    secret: z.string().regex(/^[A-Z2-7]{32}$/),
  })
  .refine(({ uri, secret }) => uriSecret(uri) === secret);
export type MfaSetup = z.infer<typeof setupSchema>;

/** Ten distinct codes as shown (`XXXX-XXXX-XXXX-XXXX`). */
const recoveryCodes = z
  .array(z.string().regex(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/))
  .length(10)
  .refine((codes) => new Set(codes).size === codes.length);
const confirmSchema = sessionSchema.extend({ recoveryCodes });
const codesSchema = z.object({ recoveryCodes });

/** Exactly one proof for a step-up. */
export type MfaProof = { readonly code: string } | { readonly recoveryCode: string };

export interface AccountClient {
  account(signal?: AbortSignal): Promise<OwnAccount>;

  /** New unconfirmed TOTP secret; shown once, never cached. */
  setupMfa(): Promise<MfaSetup>;

  /** Confirms the setup; other sessions end, this one continues. Returns the recovery codes. */
  confirmMfa(code: string): Promise<readonly string[]>;

  /** Step-up: this session becomes fresh for 5 minutes. */
  verifyMfa(proof: MfaProof): Promise<void>;

  /** New recovery codes (needs a step-up); the old ones stop working. */
  regenerateRecoveryCodes(): Promise<readonly string[]>;

  /** Removes the second factor (needs a step-up); other sessions end, this one continues. */
  removeMfa(): Promise<void>;
}

export function createAccountClient(http: HttpClient): AccountClient {
  return {
    account: (signal) => http.request('/api/auth/account', accountSchema, signal ? { signal } : {}),
    setupMfa: () => http.request('/api/auth/mfa/totp/setup', setupSchema, { method: 'POST' }),
    async confirmMfa(code) {
      const result = await http.request('/api/auth/mfa/totp/confirm', confirmSchema, {
        method: 'POST',
        body: { code },
      });
      return result.recoveryCodes;
    },
    async verifyMfa(proof) {
      await http.request('/api/auth/mfa/verify', sessionSchema, {
        method: 'POST',
        body: 'code' in proof ? { code: proof.code } : { recoveryCode: proof.recoveryCode },
      });
    },
    async regenerateRecoveryCodes() {
      const result = await http.request('/api/auth/mfa/recovery-codes', codesSchema, {
        method: 'POST',
      });
      return result.recoveryCodes;
    },
    async removeMfa() {
      await http.request('/api/auth/mfa/totp', sessionSchema, { method: 'DELETE' });
    },
  };
}

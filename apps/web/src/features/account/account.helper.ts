import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { AuthClient } from '../auth/auth.client';
import { useSession } from '../auth/session.provider';
import { ApiError } from '../../infrastructure/http.client';
import { useAccountClient } from './account-services.provider';

/** Google's issuer (with or without scheme); any other issuer is shown as configured. */
export function isGoogleIssuer(issuer: string): boolean {
  try {
    return (
      new URL(issuer.includes('://') ? issuer : `https://${issuer}`).host === 'accounts.google.com'
    );
  } catch {
    return false;
  }
}

/** The binding reference is an opaque id: only its first 8 characters are ever displayed. */
export function shortReference(reference: string): string {
  return reference.slice(0, 8);
}

/**
 * Runs a second-factor action. The API answers a wrong code and a plain expired session alike
 * with 401, so a 401 is checked against the session itself: only a session that is really gone
 * is expired locally; otherwise the refusal is handed to the caller. Callers keep their state
 * in the component (`usePrivateAction`), outside the query client.
 */
export async function runUnlessExpired<T>(
  auth: Pick<AuthClient, 'session'>,
  expire: () => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      const session = await auth.session().then(
        (value) => value,
        () => undefined,
      );
      if (session === null) await expire();
    }
    throw error;
  }
}

/** A step-up action refused for lack of a recent step-up (403). */
export function needsStepUp(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** The session's own account (email, sign-in methods, second factor); one cache entry. */
export function useOwnAccount() {
  const { namespace } = useSession();
  const account = useAccountClient();
  return useQuery({
    queryKey: [namespace, 'account', 'own'],
    queryFn: ({ signal }) => account.account(signal),
  });
}

/** As the server accepts it: case, hyphens and spaces ignored, then 16 base32 characters. */
export function isRecoveryCode(value: string): boolean {
  return /^[A-Z2-7]{16}$/.test(value.replace(/[\s-]/g, '').toUpperCase());
}

export function isTotpCode(value: string): boolean {
  return /^[0-9]{6}$/.test(value);
}

/**
 * An action whose input or result is secret (TOTP secret, step-up code, recovery codes): its
 * state lives in the component only, never in the query or mutation cache, which would keep
 * variables and results after the component is gone. One run at a time, no retry.
 */
export function usePrivateAction<A extends readonly unknown[], T>(
  action: (...args: A) => Promise<T>,
) {
  const [state, setState] = useState<{ readonly pending: boolean; readonly error: unknown }>({
    pending: false,
    error: undefined,
  });
  const running = useRef(false);

  const run = async (
    ...args: A
  ): Promise<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
  > => {
    if (running.current) return { ok: false, error: undefined };
    running.current = true;
    setState({ pending: true, error: undefined });
    try {
      const value = await action(...args);
      setState({ pending: false, error: undefined });
      return { ok: true, value };
    } catch (error) {
      setState({ pending: false, error });
      return { ok: false, error };
    } finally {
      running.current = false;
    }
  };

  return { ...state, run, reset: () => setState({ pending: false, error: undefined }) };
}

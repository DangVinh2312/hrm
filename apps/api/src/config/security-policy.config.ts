/**
 * Session and authentication timings in force. One source for the code that
 * enforces them and for the view-only security page, so the page cannot drift from the behavior.
 * Code-owned and not editable: changing a value here is a release, not a setting. Everything here
 * is non-sensitive (durations only); no key, secret or connection data may be added.
 *
 * shortcut: `idleMinutes` is only a display constant. The idle timeout (30 minutes since
 * `last_seen_at`) is enforced inside the SQL of `resolve_session` (migrations 002, 012, 018), which
 * does not read this file; the two can drift until a new migration takes the value from here. Keep
 * them equal by hand and change both together.
 */
export const securityPolicy = {
  /** `fresh` reauthentication window: a step-up older than this is no longer fresh. */
  freshAuthenticationSeconds: 300,
  /** Lifetime of a session from its creation (`createSession`). */
  sessionHours: 12,
  /** Window of the shared database rate limiter. */
  rateLimitWindowMinutes: 15,
  /** Validity of an OIDC login attempt (state/nonce/PKCE) from `begin` to the callback. */
  oidcAttemptMinutes: 5,
  /** NOT shared with the migrations' `interval '30 minutes'` (see the shortcut above). */
  idleMinutes: 30,
} as const;

export type SecurityPolicyView = { readonly [K in keyof typeof securityPolicy]: number };

/** PostgreSQL interval literals built from the policy above (trusted constants, never input). */
export const securityIntervals = {
  freshAuthentication: `interval '${securityPolicy.freshAuthenticationSeconds} seconds'`,
  session: `interval '${securityPolicy.sessionHours} hours'`,
  rateLimitWindow: `interval '${securityPolicy.rateLimitWindowMinutes} minutes'`,
  oidcAttempt: `interval '${securityPolicy.oidcAttemptMinutes} minutes'`,
} as const;

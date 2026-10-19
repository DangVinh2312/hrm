import { z } from 'zod';

/** Public, build-time settings. Everything here ships in the bundle; secrets never belong here. */
export interface WebConfig {
  /** OIDC issuer the API is configured with (Google Workspace, D10). */
  readonly oidcIssuer: string;
}

const issuerSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});

/** Missing or unsafe configuration fails the app instead of falling back to a default issuer. */
export function readWebConfig(env: Readonly<Record<string, unknown>>): WebConfig {
  const issuer = issuerSchema.safeParse(env.VITE_OIDC_ISSUER);
  if (!issuer.success) throw new Error('VITE_OIDC_ISSUER must be a fixed HTTPS issuer URL');
  return { oidcIssuer: issuer.data };
}

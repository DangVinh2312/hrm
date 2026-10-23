import * as oidc from 'openid-client';

export interface ProductOidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  version: string;
  assuranceMappings: readonly { acr: string; amr: readonly string[]; assurance: 'mfa' }[];
}

export interface ProductOidcProvider {
  readonly settings: ProductOidcProviderConfig;
  readonly configuration: oidc.Configuration;
}

export function trustedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new TypeError('OIDC requires a fixed trusted HTTPS URL');
  return url;
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Redirect URI: HTTPS, or HTTP on a loopback host for local development (RFC 8252 §7.3; ADR 0019
 * amendment). Production cannot reach the HTTP branch: config refuses an HTTP APP_ORIGIN there
 * and requires the callback on APP_ORIGIN. The issuer is always HTTPS (`trustedUrl`).
 */
export function trustedRedirectUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol === 'http:' &&
    loopbackHosts.has(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !url.search
  )
    return url;
  return trustedUrl(value);
}

export async function createProductOidcProvider(
  settings: ProductOidcProviderConfig,
): Promise<ProductOidcProvider> {
  const issuer = trustedUrl(settings.issuer);
  trustedRedirectUrl(settings.redirectUri);
  if (
    !settings.clientId ||
    settings.clientId.length > 256 ||
    !/^[1-9][0-9]{0,17}$/u.test(settings.version)
  )
    throw new TypeError('Invalid OIDC configuration');
  for (const mapping of settings.assuranceMappings) {
    if (
      !mapping.acr ||
      !mapping.amr.length ||
      mapping.amr.some((value) => typeof value !== 'string' || !value) ||
      mapping.assurance !== 'mfa'
    )
      throw new TypeError('Invalid issuer assurance mapping');
  }
  const configuration = await oidc.discovery(
    issuer,
    settings.clientId,
    {
      ...(settings.clientSecret ? { client_secret: settings.clientSecret } : {}),
      id_token_signed_response_alg: 'RS256',
    },
    settings.clientSecret ? oidc.ClientSecretPost(settings.clientSecret) : oidc.None(),
    { timeout: 5, execute: [oidc.enableNonRepudiationChecks] },
  );
  if (configuration.serverMetadata().issuer !== settings.issuer)
    throw new TypeError('OIDC issuer mismatch');
  // Fixed asymmetric algorithm and signature validation also apply over trusted TLS.
  return {
    settings: Object.freeze({
      ...settings,
      assuranceMappings: settings.assuranceMappings.map((mapping) =>
        Object.freeze({ ...mapping, amr: Object.freeze([...mapping.amr]) }),
      ),
    }),
    configuration,
  };
}

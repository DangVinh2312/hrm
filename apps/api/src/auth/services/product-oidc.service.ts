import * as oidc from 'openid-client';
import type { ProductTransaction } from '../../database/product-transaction.runner.js';
import { authTime, verifiedEmail } from '../helpers/oidc-claims.helper.js';
import {
  activateRoot,
  bindEnrollment,
  liveEnrollment,
  rootEnrollmentHash,
  rootInvitation,
} from './product-oidc-enrollment.service.js';
import {
  ProductAuthenticationError,
  ProductIdentityService,
  newSessionSecret,
  rateLimitClient,
  sessionDigest,
  type ProductSession,
} from './product-identity.service.js';
import {
  trustedRedirectUrl,
  trustedUrl,
  type ProductOidcProvider,
} from './product-oidc-provider.service.js';
import { issueOidcSession } from './product-oidc-session.service.js';
import { readOwnAccount, type ProductOwnAccount } from './product-own-account.service.js';

interface Attempt {
  nonce: string;
  verifier: string;
  provider_issuer: string;
  provider_version: string;
  redirect_uri: string;
  linking_user_id: string | null;
  enrollment_hash: Buffer | null;
  purpose: 'login' | 'activation';
}

export class ProductOidcService {
  readonly #providers: ReadonlyMap<string, ProductOidcProvider>;

  constructor(
    readonly identity: ProductIdentityService,
    providers: ReadonlyMap<string, ProductOidcProvider>,
  ) {
    this.#providers = new Map(providers);
    for (const [issuer, provider] of this.#providers) {
      if (
        issuer !== provider.settings.issuer ||
        provider.configuration.serverMetadata().issuer !== issuer
      )
        throw new TypeError('OIDC issuer mismatch');
      trustedUrl(issuer);
      trustedRedirectUrl(provider.settings.redirectUri);
      if (provider.configuration.clientMetadata().id_token_signed_response_alg !== 'RS256')
        throw new TypeError('OIDC requires the configured asymmetric signing algorithm');
      // Never accept Configuration objects with signature checking omitted.
      oidc.enableNonRepudiationChecks(provider.configuration);
      provider.configuration.timeout = 5;
    }
  }

  provider(issuer: string): ProductOidcProvider {
    const provider = this.#providers.get(issuer);
    if (!provider) throw new ProductAuthenticationError();
    return provider;
  }

  async providerCurrent(tx: ProductTransaction, provider: ProductOidcProvider): Promise<void> {
    const rows = await tx.manager.query<{ version: string }[]>(
      `SELECT version FROM oidc_provider WHERE issuer=$1 AND enabled`,
      [provider.settings.issuer],
    );
    if (rows[0]?.version !== provider.settings.version) throw new ProductAuthenticationError();
  }

  async begin(
    issuer: string,
    browserSecret: string,
    options: {
      /** ADR 0027 §6–7: no link and no Google step-up; `fresh` only comes from 2FA. */
      purpose?: 'login' | 'activation';
      /** Offline one-time invitation proof; required for activation. */
      activationToken?: string;
    },
    clientKey: string,
  ): Promise<URL> {
    const provider = this.provider(issuer);
    const browserHash = sessionDigest(browserSecret);
    await this.identity.rateLimit(clientKey, rateLimitClient(clientKey), 'oidc');
    const purpose = options.purpose ?? 'login';
    if (purpose !== 'login' && purpose !== 'activation') throw new ProductAuthenticationError();
    const state = newSessionSecret();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    await this.identity.transactions.run('identity', async (tx) => {
      await this.providerCurrent(tx, provider);
      let userId: string | null = null;
      let enrollmentHash: Buffer | null = null;
      if (purpose === 'activation') {
        if (!options.activationToken) throw new ProductAuthenticationError();
        const [invitation] = await rootInvitation(tx, issuer, {
          token: options.activationToken,
        });
        userId = invitation!.user_id;
        // Bound to this exact token: a reissue voids an attempt begun with the old proof.
        enrollmentHash = rootEnrollmentHash(invitation!, issuer);
      }
      await tx.manager.query(
        `DELETE FROM oidc_login_attempt WHERE expires_at<=statement_timestamp()`,
      );
      await tx.manager.query(
        `INSERT INTO oidc_login_attempt(state_hash,nonce,verifier,provider_issuer,provider_version,redirect_uri,expires_at,browser_hash,purpose,linking_user_id,enrollment_hash) VALUES($1,$2,$3,$4,$5,$6,statement_timestamp()+interval '5 minutes',$7,$8,$9,$10)`,
        [
          sessionDigest(state),
          nonce,
          verifier,
          issuer,
          provider.settings.version,
          provider.settings.redirectUri,
          browserHash,
          purpose,
          userId,
          enrollmentHash,
        ],
      );
    });
    return oidc.buildAuthorizationUrl(provider.configuration, {
      redirect_uri: provider.settings.redirectUri,
      response_type: 'code',
      // ADR 0020: only email/email_verified are used (first-login enrollment, email
      // verification); `profile` is requested by user decision but no profile claim is read.
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
  }

  async callback(
    issuer: string | undefined,
    currentUrl: URL,
    browserSecret: string,
  ): Promise<ProductSession> {
    if (issuer === undefined) {
      const states = currentUrl.searchParams.getAll('state');
      if (states.length !== 1) throw new ProductAuthenticationError();
      const rows = await this.identity.transactions.run<{ provider_issuer: string }[]>(
        'identity',
        (tx) =>
          tx.manager.query(
            `SELECT provider_issuer FROM oidc_login_attempt WHERE state_hash=$1 AND browser_hash=$2 AND consumed_at IS NULL AND expires_at>statement_timestamp()`,
            [sessionDigest(states[0]!), sessionDigest(browserSecret)],
          ),
      );
      if (!rows[0]) throw new ProductAuthenticationError();
      issuer = rows[0].provider_issuer;
    }
    const provider = this.provider(issuer);
    const callback = new URL(provider.settings.redirectUri);
    const codes = currentUrl.searchParams.getAll('code').length;
    const errors = currentUrl.searchParams.getAll('error').length;
    // Exactly one of: a code, or the provider's error redirect (e.g. the user cancelled).
    if (
      currentUrl.origin !== callback.origin ||
      currentUrl.pathname !== callback.pathname ||
      currentUrl.hash ||
      currentUrl.searchParams.getAll('state').length !== 1 ||
      codes + errors !== 1
    )
      throw new ProductAuthenticationError();
    const state = currentUrl.searchParams.get('state');
    if (!state) throw new ProductAuthenticationError();
    // Consume before network exchange. A failed exchange requires a fresh attempt.
    const attempt = await this.identity.transactions.run('identity', async (tx) => {
      await this.providerCurrent(tx, provider);
      const rows = await tx.manager.query<Attempt[]>(
        `WITH changed AS (UPDATE oidc_login_attempt SET consumed_at=statement_timestamp() WHERE state_hash=$1 AND browser_hash=$2 AND provider_issuer=$3 AND provider_version=$4 AND expires_at>statement_timestamp() AND consumed_at IS NULL RETURNING nonce,verifier,provider_issuer,provider_version,redirect_uri,linking_user_id,enrollment_hash,purpose) SELECT * FROM changed`,
        [sessionDigest(state), sessionDigest(browserSecret), issuer, provider.settings.version],
      );
      if (!rows[0]) throw new ProductAuthenticationError();
      return rows[0];
    });
    // A provider error (e.g. the user cancelled) spends the attempt like any other answer.
    if (errors === 1) throw new ProductAuthenticationError();
    return this.#complete(provider, issuer, state, currentUrl, attempt);
  }

  /**
   * After the consumed attempt: code exchange and ID token checks (network, outside any
   * transaction), then the purpose's transaction.
   */
  async #complete(
    provider: ProductOidcProvider,
    issuer: string,
    state: string,
    currentUrl: URL,
    attempt: Attempt,
  ): Promise<ProductSession> {
    let claims: ReturnType<Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>['claims']>;
    try {
      const tokens = await oidc.authorizationCodeGrant(provider.configuration, currentUrl, {
        pkceCodeVerifier: attempt.verifier,
        expectedState: state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch {
      throw new ProductAuthenticationError();
    }
    if (
      !claims ||
      claims.iss !== issuer ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      claims.sub.length > 512
    )
      throw new ProductAuthenticationError();
    const verified = claims;
    const assurance =
      provider.settings.assuranceMappings.find(
        (mapping) =>
          verified.acr === mapping.acr &&
          Array.isArray(verified.amr) &&
          mapping.amr.every((value) => (verified.amr as string[]).includes(value)),
      )?.assurance ?? 'oidc';
    // Absent → the session row takes statement_timestamp(); malformed → authentication failure.
    const verifiedAuthTime = authTime(verified);
    const email = verifiedEmail(verified);

    /** `revoke` mode only: there a verified claim of the account's email may verify it. */
    const issue = (tx: ProductTransaction) =>
      issueOidcSession(this.identity, tx, {
        issuer,
        subject: verified.sub,
        provider,
        assurance,
        authTime: verifiedAuthTime,
        verifiesEmail: tx.mode === 'revoke' ? email : undefined,
      });

    if (attempt.purpose === 'login') {
      // An existing (issuer, sub) binding decides alone. Only an unbound subject with a verified
      // email that matches a live enrollment goes on to the exclusive binding transaction, so an
      // unknown visitor never takes the exclusive fence.
      // A bound account whose unverified email the claim proves also takes the exclusive path:
      // verifying changes email_verified and auth_epoch (ADR 0023 §4).
      const signedIn = await this.identity.transactions.run('identity', async (tx) => {
        await this.providerCurrent(tx, provider);
        const [bound] = await tx.manager.query<{ verifies: boolean }[]>(
          `SELECT u.email_canonical=$3 AND NOT u.email_verified AS verifies
           FROM external_identity e JOIN app_user u ON u.id=e.user_id WHERE e.issuer=$1 AND e.subject=$2`,
          [issuer, verified.sub, email ?? null],
        );
        if (bound) return bound.verifies ? 'verify' : issue(tx);
        if (email === undefined || !(await liveEnrollment(tx, issuer, email, false)))
          throw new ProductAuthenticationError();
        return undefined;
      });
      if (signedIn !== undefined && signedIn !== 'verify') return signedIn;
      return this.identity.transactions.run('revoke', async (tx) => {
        await this.providerCurrent(tx, provider);
        if (signedIn === 'verify') return issue(tx);
        if (email === undefined) throw new ProductAuthenticationError();
        await bindEnrollment(tx, this.identity, issuer, verified.sub, email);
        return issue(tx);
      });
    }
    // The attempt's purpose column admits login and activation only (migration 017).
    if (attempt.purpose !== 'activation') throw new ProductAuthenticationError();
    return this.identity.transactions.run('revoke', async (tx) => {
      await this.providerCurrent(tx, provider);
      // ADR 0027 §4: the token used at begin must still be live at commit, and the IdP must vouch
      // for the enrollment's email.
      await activateRoot(tx, this.identity, {
        issuer,
        subject: verified.sub,
        email,
        userId: attempt.linking_user_id,
        attemptHash: attempt.enrollment_hash,
      });
      return issue(tx);
    });
  }

  /** The signed-in account's own email and enabled bindings (self only). */
  ownAccount(secret: string): Promise<ProductOwnAccount> {
    return readOwnAccount(this.identity, secret);
  }
}

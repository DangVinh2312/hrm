import type { ProductTransaction } from '../../database/product-transaction.runner.js';
import {
  ProductAuthenticationError,
  type ProductIdentityService,
  type ProductSession,
} from './product-identity.service.js';
import type { ProductOidcProvider } from './product-oidc-provider.service.js';

interface Binding {
  user_id: string;
  binding_version: string;
  auth_epoch: string;
  state: string;
  enabled: boolean;
}

/**
 * Session for the (issuer, sub) binding: enabled, account active. Never fresh: an IdP login is
 * not a step-up (ADR 0027 §7), only the account's own second factor is (ADR 0026).
 */
export async function issueOidcSession(
  identity: ProductIdentityService,
  tx: ProductTransaction,
  input: {
    readonly issuer: string;
    readonly subject: string;
    readonly provider: ProductOidcProvider;
    readonly assurance: string;
    /** Validated `auth_time` seconds, or `undefined` when the token has none. */
    readonly authTime: number | undefined;
    /** The verified claim email, in a `revoke` transaction only (exclusive fence). */
    readonly verifiesEmail: string | undefined;
  },
): Promise<ProductSession> {
  const { issuer, subject } = input;
  const bindings = await tx.manager.query<Binding[]>(
    `SELECT e.user_id,e.binding_version,e.enabled,u.state,u.auth_epoch FROM external_identity e JOIN app_user u ON u.id=e.user_id WHERE e.issuer=$1 AND e.subject=$2`,
    [issuer, subject],
  );
  const binding = bindings[0];
  if (!binding || !binding.enabled || binding.state !== 'active')
    throw new ProductAuthenticationError();
  let authEpoch = binding.auth_epoch;
  if (input.verifiesEmail !== undefined) {
    // The IdP verified the account's own email (ADR 0023 §4): verified once, and the new epoch
    // ends the sessions issued while it was unverified (require_email_epoch).
    const [changed] = await tx.manager.query<{ auth_epoch: string }[]>(
      `WITH changed AS (UPDATE app_user SET email_verified=true,auth_epoch=auth_epoch+1
           WHERE id=$1 AND email_canonical=$2 AND NOT email_verified RETURNING auth_epoch::text)
         SELECT * FROM changed`,
      [binding.user_id, input.verifiesEmail],
    );
    if (changed) {
      authEpoch = changed.auth_epoch;
      await identity.invalidate(tx, binding.user_id);
      await identity.audit(tx, binding.user_id, 'identity.email-verify');
    }
  }
  const session = await identity.createSession(tx, {
    userId: binding.user_id,
    authEpoch,
    assurance: input.assurance,
    issuer,
    subject,
    bindingVersion: binding.binding_version,
    providerVersion: input.provider.settings.version,
    authTime: input.authTime,
  });
  await identity.audit(tx, binding.user_id, 'identity.oidc-login');
  return session;
}

import {
  ProductAuthenticationError,
  type ProductIdentityService,
} from './product-identity.service.js';

/** Own sign-in methods of the session's account (`GET /api/auth/account`, ADR 0023 §2). */
export interface ProductOwnAccount {
  readonly email: string | null;
  /**
   * Enabled bindings at enabled providers (at most one since migration 017, ADR 0027 §6), named
   * by reference, never by subject. Nothing is removable: there is no unlink.
   */
  readonly identities: readonly { readonly issuer: string; readonly reference: string }[];
}

/**
 * The signed-in account's own email and enabled bindings at enabled
 * providers (at most 16 listed; one per account since migration 017). Self only.
 */
export async function readOwnAccount(
  identity: ProductIdentityService,
  secret: string,
): Promise<ProductOwnAccount> {
  return identity.transactions.run('identity', async (tx) => {
    const actor = await identity.authenticate(tx, secret);
    const [row] = await tx.manager.query<
      {
        email: string | null;
        identities: { issuer: string; reference: string }[];
      }[]
    >(
      `SELECT u.email_canonical AS email,
         COALESCE((SELECT json_agg(json_build_object('issuer',i.issuer,'reference',i.binding_ref) ORDER BY i.issuer,i.binding_ref)
           FROM (SELECT e.issuer,e.binding_ref FROM external_identity e JOIN oidc_provider p ON p.issuer=e.issuer
             WHERE e.user_id=u.id AND e.enabled AND p.enabled ORDER BY e.issuer,e.binding_ref LIMIT 16) i),'[]') AS identities
       FROM app_user u WHERE u.id=$1`,
      [actor.userId],
    );
    if (!row) throw new ProductAuthenticationError();
    return {
      email: row.email,
      identities: row.identities.map(({ issuer, reference }) => ({ issuer, reference })),
    };
  });
}

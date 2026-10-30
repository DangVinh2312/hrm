import type {
  Page as ProductPage,
  Row as ProductRow,
} from '../authorization/product-data.gateway.js';
import type { AppConfig } from '../config/app.config.js';
import type { BoundaryRef } from '../authorization/helpers/boundary-binding.helper.js';

export const ADMINISTRATION_HTTP_PORT = Symbol('ADMINISTRATION_HTTP_PORT');

/** Trusted administration commands; each rechecks session, policy and boundary in its transaction. */
export interface AdministrationHttpPort {
  readonly config: Pick<AppConfig, 'origin'>;

  /** account.suspend; false for absent or not visible */
  suspendUser(sessionSecret: string, userId: string): Promise<boolean>;

  /**
   * account.reactivate; false for absent, Root or not visible. A target that is not suspended is
   * ProductCommandRejected (409). The account becomes `active` with a bound Google identity,
   * `pending` otherwise; every earlier session is gone (new `auth_epoch`).
   */
  reactivateUser(sessionSecret: string, userId: string): Promise<boolean>;

  /**
   * account.provision at the deployment's one OIDC provider: the new pending account's
   * projection. Invalid email 400, taken email 409, no single provider 503.
   */
  provisionAccount(sessionSecret: string, email: string): Promise<ProductRow>;

  /**
   * account.assignRole / account.revokeRole; false for an absent or Root account, an absent role
   * or anything the caller's own grants cannot be proven to contain. Already held, not held and
   * the 20-role cap are ProductCommandRejected (409).
   */
  assignRole(sessionSecret: string, userId: string, roleKey: string): Promise<boolean>;

  revokeRole(sessionSecret: string, userId: string, roleKey: string): Promise<boolean>;

  /**
   * account.bindBoundary / account.unbindBoundary: the whole package of one boundary version on
   * another IAM account; false for an absent or Root account or anything the caller's own grants
   * cannot be proven to contain. A boundary that is not an active package of required permissions
   * is 400, a package already bound or nothing to unbind is ProductCommandRejected (409), and an
   * IAM caller that does not hold the package itself is ProductAccessDenied (403).
   */
  bindBoundary(sessionSecret: string, userId: string, boundary: BoundaryRef): Promise<boolean>;

  unbindBoundary(sessionSecret: string, userId: string, boundary: BoundaryRef): Promise<boolean>;

  /** account.read: IAM accounts ordered by email, bounded page. */
  listAccounts(
    sessionSecret: string,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<ProductPage>;
}

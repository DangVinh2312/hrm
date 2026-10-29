import type {
  Page as ProductPage,
  Row as ProductRow,
} from '../authorization/product-data.gateway.js';
import type { AppConfig } from '../config/app.config.js';

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

  /** account.read: IAM accounts ordered by email, bounded page. */
  listAccounts(
    sessionSecret: string,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<ProductPage>;
}

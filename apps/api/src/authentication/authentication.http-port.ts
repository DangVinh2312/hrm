import type {
  ProductIdentityService,
  ProductSession,
  ProductSessionIdentity,
} from './services/product-identity.service.js';
import type { ProductOidcService } from './services/product-oidc.service.js';
import type { ProductMfaService } from './services/product-mfa.service.js';
import type { AppConfig } from '../config/app.config.js';

export const AUTHENTICATION_HTTP_PORT = Symbol('AUTHENTICATION_HTTP_PORT');

/**
 * Callback outcome for the browser redirect (ADR 0019). Only an authentication failure becomes
 * `failed`; any other fault still throws so the error filter logs it and answers safely.
 */
export type OidcCallbackOutcome =
  | { readonly kind: 'authenticated'; readonly session: ProductSession }
  | { readonly kind: 'failed' };

/** Menus the server grants for display (design §10.2); every operation still decides itself. */
export type SessionMenu = 'accounts';

/** Menu keys the server grants for display (design §10.2); only implemented pages are listed. */
export type MeMenu =
  | 'requests'
  | 'approvals'
  | 'employees'
  | 'teams'
  | 'calendar'
  | 'leave'
  | 'attendance'
  | 'reports'
  | 'accounts'
  | 'settings';

/**
 * `GET /api/auth/me` (design §10.2, ADR 0037): only what needs the account id and permissions.
 * No profile, role key, revision or F2 value; the employee profile is `GET /api/hr/employees/me`.
 */
export interface MeView {
  readonly userId: string;
  readonly menus: readonly MeMenu[];
}

/** Bound session/identity operations: no transactions, pools, connection settings or offline commands. */
export interface AuthenticationHttpPort {
  readonly config: Pick<AppConfig, 'origin'>;
  readonly identity: Pick<ProductIdentityService, 'logout'>;
  readonly oidc: Pick<ProductOidcService, 'begin' | 'ownAccount'> & {
    callback(...args: Parameters<ProductOidcService['callback']>): Promise<OidcCallbackOutcome>;
  };
  /** The session's own second factor (ADR 0026); every operation authenticates the session. */
  readonly mfa: Pick<
    ProductMfaService,
    'status' | 'setup' | 'confirm' | 'verify' | 'regenerateRecoveryCodes' | 'remove'
  >;

  currentSession(secret: string): Promise<ProductSessionIdentity>;

  menus(secret: string): Promise<readonly SessionMenu[]>;

  /** Account id and granted menus; any signed-in account, with or without an employee or roles. */
  me(secret: string): Promise<MeView>;
}

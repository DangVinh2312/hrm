import type { ProductAuthorization } from '../../authorization/services/product-authority.service.js';
import type { RoleReadRepository } from './repositories/role-read.repository.js';
import type { AccountPermissionView, RoleMatrixView } from './role.types.js';

export const roleQueries = (reads: RoleReadRepository) =>
  [reads.list, reads.accountPermissions] as const;

/**
 * Role matrix operations bound to the registered queries. Every read returns `undefined` when
 * the caller's plan does not reach the record (no grant, Root target, absent account): HTTP 404,
 * one answer for all of them.
 */
export class RoleService {
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly reads: RoleReadRepository,
  ) {}

  /** role.read */
  list(secret: string): Promise<RoleMatrixView | undefined> {
    return this.authorization.query(secret, this.reads.list, undefined);
  }

  /** account.readPermissions; a malformed id is a 400 before any transaction. */
  accountPermissions(
    secret: string,
    accountId: string,
  ): Promise<AccountPermissionView | undefined> {
    return this.authorization.query(secret, this.reads.accountPermissions, { accountId });
  }
}

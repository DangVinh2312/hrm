import { NotFoundException } from '@nestjs/common';
import {
  ProductAccessDenied,
  type ProductAuthorization,
  type ProductCommand,
} from '../../authorization/services/product-authority.service.js';
import {
  RoleNotFound,
  type RoleCommandRepository,
} from './repositories/role-command.repository.js';
import type { RoleReadRepository } from './repositories/role-read.repository.js';
import type {
  AccountPermissionView,
  RoleCreateInput,
  RoleMatrixView,
  RoleUpdateInput,
  RoleWriteResult,
} from './role.types.js';
import { checkRoleCatalog } from './role.validator.js';

export const roleQueries = (reads: RoleReadRepository) =>
  [reads.list, reads.accountPermissions] as const;

export const roleCommands = (commands: RoleCommandRepository) =>
  [commands.create, commands.update, commands.remove] as const;

/**
 * Role operations bound to the registered queries and commands. Every read returns `undefined`
 * when the caller's plan does not reach the record (no grant, Root target, absent account): HTTP
 * 404, one answer for all of them. A write without the grant is `ProductAccessDenied` (403); a role
 * that is absent, not runtime, or larger than the actor's own set is a `NotFoundException` (404).
 */
export class RoleService {
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly reads: RoleReadRepository,
    private readonly commands: RoleCommandRepository,
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

  /** role.create; the catalog is checked before the exclusive fence is taken. */
  async create(secret: string, input: RoleCreateInput): Promise<RoleWriteResult> {
    checkRoleCatalog(this.commands.declarations, input.grants);
    return this.#write(secret, this.commands.create, input);
  }

  /** role.update: the whole new label and grant set against the digest of the current one. */
  async update(secret: string, input: RoleUpdateInput): Promise<RoleWriteResult> {
    checkRoleCatalog(this.commands.declarations, input.grants);
    return this.#write(secret, this.commands.update, input);
  }

  remove(secret: string, key: string): Promise<{ readonly status: 'deleted' }> {
    return this.#write(secret, this.commands.remove, { key });
  }

  async #write<I, R>(secret: string, command: ProductCommand<I, R>, input: I): Promise<R> {
    try {
      const done = await this.authorization.execute(secret, command, input);
      // The anchor is a constant-scope singleton, so "not reached" is a plan without the grant.
      if (!done) throw new ProductAccessDenied();
      return done;
    } catch (error) {
      if (error instanceof RoleNotFound) throw new NotFoundException();
      throw error;
    }
  }
}

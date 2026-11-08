import { randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import type { ProductBindingRegistry } from '../product-sql.compiler.js';
import { ProductDataGateway, ProductInvalidRequest, type Row } from '../product-data.gateway.js';
import { canonicalLoginEmail } from '../../authentication/services/product-identity.service.js';
import type { ProductAuditRepository } from '../../audit/product-audit.repository.js';
import { compareGrantSets, grantSetWithin } from '../helpers/grant-set.helper.js';
import { isRoleKeyReference } from '../helpers/role-grant.helper.js';
import {
  AccountRoleRepository,
  MAX_ACCOUNT_ROLES,
} from '../repositories/account-role.repository.js';
import { GrantFactsRepository } from '../repositories/grant-facts.repository.js';
import { AdminAccountCommand } from './admin-account-command.service.js';
import { type ProductAuthorization } from './product-authority.service.js';
import { ProductAccessDenied, ProductCommandRejected } from './product-authority.types.js';

/**
 * Commands on IAM accounts. They are methods, not `ProductCommand`s,
 * because `ProductAuthorization.execute` cannot lock the `account_directory` view; each one runs
 * through the session, plan and fence of `ProductAuthorization.access`, which this class only
 * calls and never reimplements. New account commands belong here.
 */
export class ProductAccountService {
  private readonly gateway: ProductDataGateway;
  /** Stateless reader of the grant-set facts; no dependency, built here. */
  private readonly grants = new GrantFactsRepository();
  private readonly roles = new AccountRoleRepository();
  private readonly command: AdminAccountCommand;

  constructor(
    private readonly authority: ProductAuthorization,
    private readonly audit: ProductAuditRepository,
    private readonly bindings: ProductBindingRegistry,
  ) {
    this.gateway = new ProductDataGateway(bindings);
    this.command = new AdminAccountCommand(authority, bindings);
  }

  /**
   * account.provision with its first role: a pending IAM account with this email, a
   * 7-day enrollment at `issuer` and `roleKey`, in one `admin` transaction. The caller needs
   * `account.assignRole` too, answered first under the shared fence. `undefined` (404), before
   * anything is written, for an absent role or, for IAM, a role not within the caller's grants.
   * The new account must be visible through both plans (a scoped grant cannot create outside its
   * scope), else 403. A taken email is ProductCommandRejected (409).
   */
  async provisionAccount(
    secret: string,
    email: string,
    issuer: string,
    roleKey: string,
  ): Promise<Row | undefined> {
    let canonical: string;
    try {
      canonical = canonicalLoginEmail(email);
    } catch {
      throw new ProductInvalidRequest('Invalid email');
    }
    if (!isRoleKeyReference(roleKey)) throw new ProductInvalidRequest('Invalid role key');
    const pairs = [
      { resource: 'account', action: 'provision' },
      { resource: 'account', action: 'assignRole' },
    ];
    if (!(await this.authority.allowsAll(secret, pairs))) throw new ProductAccessDenied();
    const userId = randomUUID();
    return this.authority.access(
      secret,
      'account',
      'provision',
      'admin',
      async (plan, tx, kind, session) => {
        const { manager } = tx;
        if (kind === 'iam') {
          const { facts, truncated } = await this.grants.read(manager, [plan.userId]);
          const role = await this.roles.roleRules(manager, roleKey);
          const actorGrants = facts.get(plan.userId) ?? [];
          if (truncated || !role || role.truncated) return undefined;
          if (!grantSetWithin(compareGrantSets(role.facts, actorGrants))) return undefined;
        } else if (!(await this.roles.roleExists(manager, roleKey))) return undefined;
        try {
          await manager.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
            userId,
            canonical,
            issuer,
            plan.userId,
          ]);
        } catch (error) {
          if (
            error instanceof QueryFailedError &&
            (error.driverError as { code?: unknown }).code === '23505'
          )
            throw new ProductCommandRejected('account exists');
          throw error;
        }
        const row = await this.gateway.detail(
          plan,
          this.bindings.core.parseKey('uuid', userId),
          tx,
        );
        if (
          !row ||
          !(await this.authority.reachesIn(tx, session, 'account', 'assignRole', userId, true))
        )
          throw new ProductAccessDenied();
        if (!(await this.roles.insert(manager, userId, roleKey)))
          throw new ProductCommandRejected('role_held');
        if (kind === 'iam')
          await this.audit.appendProductAudit(tx, {
            kind: 'account.provision',
            actor: plan.userId,
            permission: plan.permission,
            target: { userId },
          });
        const event = {
          kind: 'permission.role-assign',
          actor: plan.userId,
          permission: 'account.assignRole',
          target: { resource: 'account', keyKind: 'uuid', key: userId, objectId: userId },
          detail: { roleKey, targetUserId: userId },
        } as const;
        await this.audit.appendProductAudit(
          tx,
          kind === 'root' ? { ...event, principalKind: 'root', outcome: 'ok' } : event,
        );
        return row;
      },
      (plan, row) =>
        row
          ? {
              kind: 'account.provision',
              actor: plan.userId,
              permission: plan.permission,
              principalKind: 'root',
              outcome: 'ok',
              target: { userId },
            }
          : {
              kind: 'access.account.provision',
              actor: plan.userId,
              permission: plan.permission,
              principalKind: 'root',
              outcome: 'absent',
            },
    );
  }

  async suspendUser(secret: string, target: string): Promise<boolean> {
    if (!this.bindings.core.isCanonicalUuid(target)) throw new ProductAccessDenied();
    return this.command.run(
      secret,
      'suspend',
      target,
      async (plan, tx, kind) => {
        if (!(await this.grants.targetWithinActor(tx.manager, { id: plan.userId, kind }, target)))
          return false;
        await tx.manager.query(
          `UPDATE app_user SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1`,
          [target],
        );
        if (kind === 'iam')
          await this.audit.appendProductAudit(tx, {
            kind: 'account.suspend',
            actor: plan.userId,
            permission: plan.permission,
            target: { userId: target },
          });
        return true;
      },
      (plan, suspended) => ({
        kind: 'account.suspend',
        actor: plan.userId,
        permission: plan.permission,
        principalKind: 'root',
        outcome: suspended ? 'ok' : 'absent',
        target: { userId: target },
      }),
    );
  }

  /**
   * account.reactivate: the reverse of `suspendUser`, with the same order. `false`
   * for an absent id or any Root (one lookup through the IAM-only projection); self is 403; an
   * account that is not suspended is ProductCommandRejected (409). The state change is the
   * SECURITY DEFINER function, which also advances `auth_epoch` (no session returns).
   */
  async reactivateUser(secret: string, target: string): Promise<boolean> {
    if (!this.bindings.core.isCanonicalUuid(target)) throw new ProductAccessDenied();
    return this.command.run(
      secret,
      'reactivate',
      target,
      async (plan, tx, kind) => {
        // Before the state check, so a larger account never reveals whether it is suspended.
        if (!(await this.grants.targetWithinActor(tx.manager, { id: plan.userId, kind }, target)))
          return false;
        try {
          await tx.manager.query('SELECT public.reactivate_iam_account($1)', [target]);
        } catch (error) {
          // 55000: another command moved the account out of `suspended` first (lost the race).
          if (
            error instanceof QueryFailedError &&
            (error.driverError as { code?: unknown }).code === '55000'
          )
            throw new ProductCommandRejected('not_suspended');
          throw error;
        }
        if (kind === 'iam')
          await this.audit.appendProductAudit(tx, {
            kind: 'account.reactivate',
            actor: plan.userId,
            permission: plan.permission,
            target: { userId: target },
          });
        return true;
      },
      (plan, reactivated) => ({
        kind: 'account.reactivate',
        actor: plan.userId,
        permission: plan.permission,
        principalKind: 'root',
        outcome: reactivated ? 'ok' : 'absent',
        target: { userId: target },
      }),
    );
  }

  /**
   * account.assignRole: one role to another IAM account, in any account state. Order as
   * `suspendUser` (directory lookup, self 403, lock of the account row), then the facts of actor
   * and target in one statement: (d) the target set within the actor's, (c) every rule of the
   * role within the actor's, then the state: already held or 20 roles is ProductCommandRejected
   * (409). `false` (404) for an absent or Root account, an absent role, or anything the actor's
   * set cannot be proven to contain. Root skips both comparisons.
   */
  assignRole(secret: string, target: string, roleKey: string): Promise<boolean> {
    return this.changeRole(secret, target, roleKey, 'assignRole');
  }

  /** account.revokeRole: the reverse of `assignRole` with (d) but without (c); not held or the last role is a 409. */
  revokeRole(secret: string, target: string, roleKey: string): Promise<boolean> {
    return this.changeRole(secret, target, roleKey, 'revokeRole');
  }

  private async changeRole(
    secret: string,
    target: string,
    roleKey: string,
    action: 'assignRole' | 'revokeRole',
  ): Promise<boolean> {
    if (!this.bindings.core.isCanonicalUuid(target)) throw new ProductAccessDenied();
    if (!isRoleKeyReference(roleKey)) throw new ProductInvalidRequest('Invalid role key');
    const assigning = action === 'assignRole';
    return this.command.run(
      secret,
      action,
      target,
      async (plan, tx, kind) => {
        const { manager } = tx;
        await this.roles.lockAccount(manager, target);
        const { within, actorGrants } = await this.grants.withinActor(
          manager,
          { id: plan.userId, kind },
          target,
        );
        if (!within) return false;
        if (assigning && kind === 'iam') {
          const role = await this.roles.roleRules(manager, roleKey);
          if (!role || role.truncated) return false;
          if (!grantSetWithin(compareGrantSets(role.facts, actorGrants))) return false;
        } else if (!(await this.roles.roleExists(manager, roleKey))) return false;
        const { count, held } = await this.roles.holding(manager, target, roleKey);
        if (assigning) {
          if (held) throw new ProductCommandRejected('role_held');
          if (count >= MAX_ACCOUNT_ROLES) throw new ProductCommandRejected('role_limit');
          if (!(await this.roles.insert(manager, target, roleKey)))
            throw new ProductCommandRejected('role_held');
        } else {
          if (!held) throw new ProductCommandRejected('role_not_held');
          // An IAM account keeps at least one role; suspend removes all access instead.
          if (count <= 1) throw new ProductCommandRejected('last_role');
          if (!(await this.roles.delete(manager, target, roleKey)))
            throw new ProductCommandRejected('role_not_held');
        }
        const event = {
          kind: assigning ? 'permission.role-assign' : 'permission.role-revoke',
          actor: plan.userId,
          permission: plan.permission,
          target: { resource: 'account', keyKind: 'uuid', key: target, objectId: target },
          detail: { roleKey, targetUserId: target },
        } as const;
        await this.audit.appendProductAudit(
          tx,
          kind === 'root' ? { ...event, principalKind: 'root', outcome: 'ok' } : event,
        );
        return true;
      },
      (plan, done) =>
        done
          ? undefined
          : {
              kind: `access.account.${action}`,
              actor: plan.userId,
              permission: plan.permission,
              principalKind: 'root',
              outcome: 'absent',
              target: { resource: 'account', keyKind: 'uuid', key: target },
            },
    );
  }
}

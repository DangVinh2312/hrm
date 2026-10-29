import { randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import type { ProductTransaction } from '../../database/product-transaction.runner.js';
import type { ProductBindingRegistry } from '../product-sql.compiler.js';
import { ProductDataGateway, ProductInvalidRequest, type Row } from '../product-data.gateway.js';
import { canonicalLoginEmail } from '../../authentication/services/product-identity.service.js';
import type {
  ProductAuditEvent,
  ProductAuditRepository,
} from '../../audit/product-audit.repository.js';
import type { UserAuthorizedPlan } from '../core/authorization.types.js';
import {
  type GrantRuleFact,
  compareGrantSets,
  grantSetWithin,
  targetAccess,
} from '../helpers/grant-set.helper.js';
import { isRoleKeyReference } from '../helpers/role-grant.helper.js';
import {
  AccountRoleRepository,
  MAX_ACCOUNT_ROLES,
} from '../repositories/account-role.repository.js';
import { GrantFactsRepository } from '../repositories/grant-facts.repository.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type PrincipalKind,
  type ProductAuthorization,
} from './product-authority.service.js';

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

  constructor(
    private readonly authority: ProductAuthorization,
    private readonly audit: ProductAuditRepository,
    private readonly bindings: ProductBindingRegistry,
  ) {
    this.gateway = new ProductDataGateway(bindings);
  }

  /**
   * account.provision: a pending IAM account with this email and a 7-day enrollment
   * at `issuer`, created by the SECURITY DEFINER function in this `write` transaction. The new row
   * must be visible through the caller's plan (a scoped grant cannot create outside its scope) and
   * is returned as the account projection. A taken email is ProductCommandRejected (409).
   */
  async provisionAccount(secret: string, email: string, issuer: string): Promise<Row> {
    let canonical: string;
    try {
      canonical = canonicalLoginEmail(email);
    } catch {
      throw new ProductInvalidRequest('Invalid email');
    }
    const userId = randomUUID();
    return this.authority.access(
      secret,
      'account',
      'provision',
      'write',
      async (plan, tx, kind) => {
        try {
          await tx.manager.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
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
        if (!row) throw new ProductAccessDenied();
        if (kind === 'iam')
          await this.audit.appendProductAudit(tx, {
            kind: 'account.provision',
            actor: plan.userId,
            permission: plan.permission,
            target: { userId },
          });
        return row;
      },
      (plan) => ({
        kind: 'account.provision',
        actor: plan.userId,
        permission: plan.permission,
        principalKind: 'root',
        outcome: 'ok',
        target: { userId },
      }),
    );
  }

  /**
   * `access` in `admin` mode behind a shared-fence answer: a caller whose plan does not reach
   * `target` (no grant, no binding, Root, absent id) gets `unreached` without taking the exclusive
   * fence or advancing the revision. The exclusive step decides again, so the pre-check is only a hint.
   */
  private async adminCommand<T>(
    secret: string,
    action: string,
    target: string,
    unreached: T,
    work: (plan: UserAuthorizedPlan, tx: ProductTransaction, kind: PrincipalKind) => Promise<T>,
    rootEvent: (plan: UserAuthorizedPlan, result: T) => ProductAuditEvent | undefined,
  ): Promise<T> {
    if (!(await this.authority.reachesTarget(secret, 'account', action, target))) return unreached;
    return this.authority.access(secret, 'account', action, 'admin', work, rootEvent);
  }

  /**
   * An IAM actor acts on another account only when the target's effective grant
   * set is within its own; otherwise the caller answers "not found" like an absent account. Root
   * skips the comparison and reads nothing. Runs inside the exclusive fence of an `admin`
   * command: one statement reads both sets and no authority fact can change before commit.
   */
  private async targetWithinActor(
    tx: ProductTransaction,
    actor: { id: string; kind: PrincipalKind },
    target: string,
  ): Promise<boolean> {
    if (actor.kind === 'root') return true;
    const { facts, truncated } = await this.grants.read(tx.manager, [actor.id, target]);
    // An incomplete read cannot prove inclusion: refuse (404), never compare a cut-off set.
    if (truncated) return false;
    return (
      targetAccess({ kind: 'iam', grants: facts.get(actor.id) ?? [] }, facts.get(target) ?? []) ===
      'proceed'
    );
  }

  async suspendUser(secret: string, target: string): Promise<boolean> {
    if (!this.bindings.core.isCanonicalUuid(target)) throw new ProductAccessDenied();
    return this.adminCommand(
      secret,
      'suspend',
      target,
      false,
      async (plan, tx, kind) => {
        // One lookup through iam_account first: an absent id and any Root (Root included when it
        // targets itself) are the same "not found" (spec 7.2). Only then the IAM self check.
        const row = await this.gateway.detail(
          plan,
          this.bindings.core.parseKey('uuid', target),
          tx,
        );
        if (!row) return false;
        if (plan.userId === target) throw new ProductAccessDenied();
        if (!(await this.targetWithinActor(tx, { id: plan.userId, kind }, target))) return false;
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
    return this.adminCommand(
      secret,
      'reactivate',
      target,
      false,
      async (plan, tx, kind) => {
        const row = await this.gateway.detail(
          plan,
          this.bindings.core.parseKey('uuid', target),
          tx,
        );
        if (!row) return false;
        if (plan.userId === target) throw new ProductAccessDenied();
        // Before the state check, so a larger account never reveals whether it is suspended.
        if (!(await this.targetWithinActor(tx, { id: plan.userId, kind }, target))) return false;
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

  /** account.revokeRole: the reverse of `assignRole` with (d) but without (c); not held is a 409. */
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
    return this.adminCommand(
      secret,
      action,
      target,
      false,
      async (plan, tx, kind) => {
        const row = await this.gateway.detail(
          plan,
          this.bindings.core.parseKey('uuid', target),
          tx,
        );
        if (!row) return false;
        if (plan.userId === target) throw new ProductAccessDenied();
        const { manager } = tx;
        await this.roles.lockAccount(manager, target);
        let actorGrants: GrantRuleFact[] = [];
        if (kind === 'iam') {
          const { facts, truncated } = await this.grants.read(manager, [plan.userId, target]);
          actorGrants = facts.get(plan.userId) ?? [];
          if (truncated) return false;
          const reach = targetAccess({ kind, grants: actorGrants }, facts.get(target) ?? []);
          if (reach !== 'proceed') return false;
        }
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
          if (!held || !(await this.roles.delete(manager, target, roleKey)))
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

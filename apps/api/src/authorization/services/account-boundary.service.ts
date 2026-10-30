import type { EntityManager } from 'typeorm';
import type { ProductBindingRegistry } from '../product-sql.compiler.js';
import { ProductDataGateway, ProductInvalidRequest } from '../product-data.gateway.js';
import type { ProductAuditRepository } from '../../audit/product-audit.repository.js';
import {
  type BoundaryRef,
  MAX_BOUNDARY_PACKAGE,
  isBoundaryRef,
} from '../helpers/boundary-binding.helper.js';
import { targetAccess } from '../helpers/grant-set.helper.js';
import { AccountBoundaryRepository } from '../repositories/account-boundary.repository.js';
import { AccountRoleRepository } from '../repositories/account-role.repository.js';
import { GrantFactsRepository } from '../repositories/grant-facts.repository.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type PrincipalKind,
  type ProductAuthorization,
} from './product-authority.service.js';

/**
 * account.bindBoundary / account.unbindBoundary (ADR-13): the whole package of a boundary on
 * another IAM account, in one `admin` transaction. Like the other account commands they are
 * methods over `ProductAuthorization.access`, never `execute`, because the account row is only
 * visible through the `account_directory` view.
 */
export class AccountBoundaryService {
  private readonly gateway: ProductDataGateway;
  private readonly grants = new GrantFactsRepository();
  private readonly accountRows = new AccountRoleRepository();
  private readonly boundaries = new AccountBoundaryRepository();

  constructor(
    private readonly authority: ProductAuthorization,
    private readonly audit: ProductAuditRepository,
    private readonly bindings: ProductBindingRegistry,
  ) {
    this.gateway = new ProductDataGateway(bindings);
  }

  /**
   * `false` for an absent or Root account or a target whose grants the actor's do not contain.
   * Self and a missing hold of the actor are ProductAccessDenied (403); a boundary that is not an
   * active package of required permissions is ProductInvalidRequest (400); a binding on any
   * permission of the package already is ProductCommandRejected `boundary_bound` (409). Root skips
   * the grant comparison and the hold.
   */
  bindBoundary(secret: string, target: string, ref: BoundaryRef): Promise<boolean> {
    return this.change(secret, target, ref, 'bindBoundary');
  }

  /**
   * The reverse: deletes the runtime rows of the package. Needs no hold of the actor (taking
   * authority away needs no delegation). Nothing to delete is ProductCommandRejected
   * `boundary_not_bound` (409); rows with a `seed_owner` are never touched.
   */
  unbindBoundary(secret: string, target: string, ref: BoundaryRef): Promise<boolean> {
    return this.change(secret, target, ref, 'unbindBoundary');
  }

  private async change(
    secret: string,
    target: string,
    ref: BoundaryRef,
    action: 'bindBoundary' | 'unbindBoundary',
  ): Promise<boolean> {
    if (!this.bindings.core.isCanonicalUuid(target)) throw new ProductAccessDenied();
    if (!isBoundaryRef(ref)) throw new ProductInvalidRequest('Invalid boundary');
    const binding = action === 'bindBoundary';
    // A caller whose plan does not reach the target is answered under the shared fence: it never
    // takes the exclusive one. The exclusive step decides again.
    if (!(await this.authority.reachesTarget(secret, 'account', action, target))) return false;
    return this.authority.access(
      secret,
      'account',
      action,
      'admin',
      async (plan, tx, kind) => {
        const row = await this.gateway.detail(
          plan,
          this.bindings.core.parseKey('uuid', target),
          tx,
        );
        if (!row) return false;
        if (plan.userId === target) throw new ProductAccessDenied();
        const { manager } = tx;
        await this.accountRows.lockAccount(manager, target);
        if (kind === 'iam' && !(await this.targetWithinActor(manager, plan.userId, target)))
          return false;
        if (binding) await this.bind(manager, { id: plan.userId, kind }, target, ref);
        else if ((await this.boundaries.deleteRuntime(manager, target, ref)) === 0)
          throw new ProductCommandRejected('boundary_not_bound');
        const event = {
          kind: binding ? 'permission.boundary-assign' : 'permission.boundary-revoke',
          actor: plan.userId,
          permission: plan.permission,
          target: { resource: 'account', keyKind: 'uuid', key: target, objectId: target },
          detail: { boundaryKey: ref.key, boundaryVersion: ref.version, targetUserId: target },
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

  /** (d): the target's effective grants within the actor's; an incomplete read cannot prove it. */
  private async targetWithinActor(
    manager: EntityManager,
    actor: string,
    target: string,
  ): Promise<boolean> {
    const { facts, truncated } = await this.grants.read(manager, [actor, target]);
    return (
      !truncated &&
      targetAccess({ kind: 'iam', grants: facts.get(actor) ?? [] }, facts.get(target) ?? []) ===
        'proceed'
    );
  }

  private async bind(
    manager: EntityManager,
    actor: { id: string; kind: PrincipalKind },
    target: string,
    ref: BoundaryRef,
  ): Promise<void> {
    const members = await this.boundaries.packageOf(manager, ref);
    if (
      members.length === 0 ||
      members.length > MAX_BOUNDARY_PACKAGE ||
      members.some((member) => !member.required)
    )
      throw new ProductInvalidRequest('Invalid boundary');
    const { actorHeld, targetBound } = await this.boundaries.bindingsOf(
      manager,
      actor.id,
      target,
      ref,
    );
    // Before the 409, so a caller who may not bind the package never learns what the target holds.
    if (actor.kind === 'iam' && actorHeld !== members.length) throw new ProductAccessDenied();
    if (targetBound > 0) throw new ProductCommandRejected('boundary_bound');
    if ((await this.boundaries.insert(manager, target, ref)) !== members.length)
      throw new ProductCommandRejected('boundary_bound');
  }
}

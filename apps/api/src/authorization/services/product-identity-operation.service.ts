import { type EntityManager, QueryFailedError } from 'typeorm';
import type { ProductTransaction } from '../../database/product-transaction.runner.js';
import type { ProductBindingRegistry } from '../product-sql.compiler.js';
import { ProductDataGateway, ProductInvalidRequest } from '../product-data.gateway.js';
import { canonicalLoginEmail } from '../../authentication/services/product-identity.service.js';
import { AccountAction } from '../../administration/account-authorization.types.js';
import type {
  ProductAuditRepository,
  ProductIdentityOperationAuditKind,
} from '../../audit/product-audit.repository.js';
import { targetAccess } from '../helpers/grant-set.helper.js';
import { GrantFactsRepository } from '../repositories/grant-facts.repository.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type PrincipalKind,
  type ProductAuthorization,
} from './product-authority.service.js';

const sqlState = (error: unknown): unknown =>
  error instanceof QueryFailedError ? (error.driverError as { code?: unknown }).code : undefined;

/** The function's own kind check; any other 42501 (revoked EXECUTE, ACL drift) is a fault. */
const isNotIamRefusal = (error: unknown): boolean =>
  error instanceof QueryFailedError &&
  /^only IAM accounts /.test(String((error.driverError as { message?: unknown }).message));

/**
 * account.changeEmail / resetMfa / resetGoogleBinding (ADR-15): the global identity of another
 * IAM account, changed by the SECURITY DEFINER functions of the authority login in one `admin`
 * transaction. Like the other account commands they are methods over
 * `ProductAuthorization.access`, never `execute`, because the account row is only visible through
 * the `account_directory` view. Each returns `false` (404) for an absent or Root account or a
 * target whose grants the actor's do not contain; oneself is ProductAccessDenied (403); nothing to
 * change, a taken email or no second factor is ProductCommandRejected (409).
 */
export class ProductIdentityOperationService {
  private readonly gateway: ProductDataGateway;
  private readonly grants = new GrantFactsRepository();

  constructor(
    private readonly authority: ProductAuthorization,
    private readonly audit: ProductAuditRepository,
    private readonly bindings: ProductBindingRegistry,
  ) {
    this.gateway = new ProductDataGateway(bindings);
  }

  /** `issuer` is the deployment's provider, never a request value; the email is lowercased here. */
  async changeEmail(
    secret: string,
    target: string,
    email: string,
    issuer: string,
  ): Promise<boolean> {
    if (!this.bindings.core.isCanonicalUuid(target)) throw new ProductAccessDenied();
    let canonical: string;
    try {
      canonical = canonicalLoginEmail(email);
    } catch {
      throw new ProductInvalidRequest('Invalid email');
    }
    return this.run(
      secret,
      target,
      AccountAction.ChangeEmail,
      'identity.email-change',
      (manager, actor) =>
        manager.query('SELECT public.change_iam_account_email($1,$2,$3,$4)', [
          target,
          canonical,
          issuer,
          actor,
        ]),
    );
  }

  async resetMfa(secret: string, target: string): Promise<boolean> {
    if (!this.bindings.core.isCanonicalUuid(target)) throw new ProductAccessDenied();
    return this.run(
      secret,
      target,
      AccountAction.ResetMfa,
      'identity.mfa-reset-by-permission',
      (manager) => manager.query('SELECT public.reset_iam_mfa($1)', [target]),
    );
  }

  async resetGoogleBinding(secret: string, target: string, issuer: string): Promise<boolean> {
    if (!this.bindings.core.isCanonicalUuid(target)) throw new ProductAccessDenied();
    return this.run(
      secret,
      target,
      AccountAction.ResetGoogleBinding,
      'identity.binding-reset',
      (manager, actor) =>
        manager.query('SELECT public.reset_iam_google_binding($1,$2,$3)', [target, issuer, actor]),
    );
  }

  /**
   * A caller whose plan does not reach `target` is answered under the shared fence and never takes
   * the exclusive one. The exclusive step decides again: lookup through the IAM-only projection,
   * self (403), (d) the target's grants within the actor's, then the function, then the audit.
   */
  private async run(
    secret: string,
    target: string,
    action: AccountAction,
    kind: ProductIdentityOperationAuditKind,
    call: (manager: EntityManager, actor: string) => Promise<unknown>,
  ): Promise<boolean> {
    if (!(await this.authority.reachesTarget(secret, 'account', action, target))) return false;
    return this.authority.access(
      secret,
      'account',
      action,
      'admin',
      async (plan, tx, principal) => {
        const row = await this.gateway.detail(
          plan,
          this.bindings.core.parseKey('uuid', target),
          tx,
        );
        if (!row) return false;
        if (plan.userId === target) throw new ProductAccessDenied();
        if (!(await this.targetWithinActor(tx, { id: plan.userId, kind: principal }, target)))
          return false;
        if (!(await this.invoke(tx.manager, () => call(tx.manager, plan.userId)))) return false;
        if (principal === 'iam')
          await this.audit.appendProductAudit(tx, {
            kind,
            actor: plan.userId,
            permission: plan.permission,
            target: { userId: target },
          });
        return true;
      },
      (plan, done) => ({
        kind,
        actor: plan.userId,
        permission: plan.permission,
        principalKind: 'root',
        outcome: done ? 'ok' : 'absent',
        target: { userId: target },
      }),
    );
  }

  /**
   * P0002 and the function's "only IAM accounts" 42501 (absent or not IAM) only happen when the account changed kind after the
   * lookup: rolled back to the savepoint so the transaction can still write the Root audit event.
   * 55000 and 23505 are the business refusals. Anything else, 22023 (issuer or email the function
   * refuses) included, is a fault and not an answer.
   */
  private async invoke(manager: EntityManager, call: () => Promise<unknown>): Promise<boolean> {
    await manager.query('SAVEPOINT identity_operation');
    try {
      await call();
    } catch (error) {
      const state = sqlState(error);
      if (state === 'P0002' || (state === '42501' && isNotIamRefusal(error))) {
        await manager.query('ROLLBACK TO SAVEPOINT identity_operation');
        return false;
      }
      if (state === '55000' || state === '23505') throw new ProductCommandRejected('conflict');
      throw error;
    }
    return true;
  }

  /** (d): an incomplete read cannot prove inclusion, so it refuses; Root skips the comparison. */
  private async targetWithinActor(
    tx: ProductTransaction,
    actor: { id: string; kind: PrincipalKind },
    target: string,
  ): Promise<boolean> {
    if (actor.kind === 'root') return true;
    const { facts, truncated } = await this.grants.read(tx.manager, [actor.id, target]);
    if (truncated) return false;
    return (
      targetAccess({ kind: 'iam', grants: facts.get(actor.id) ?? [] }, facts.get(target) ?? []) ===
      'proceed'
    );
  }
}

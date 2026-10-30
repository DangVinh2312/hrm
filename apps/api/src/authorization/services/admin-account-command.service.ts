import type { ProductTransaction } from '../../database/product-transaction.runner.js';
import type { ProductAuditEvent } from '../../audit/product-audit.repository.js';
import type { UserAuthorizedPlan } from '../core/authorization.types.js';
import { ProductDataGateway } from '../product-data.gateway.js';
import type { PrincipalKind } from '../product-principal.types.js';
import type { ProductBindingRegistry } from '../product-sql.compiler.js';
import { type ProductAuthorization } from './product-authority.service.js';
import { ProductAccessDenied } from './product-authority.types.js';

/**
 * Frame of the commands on another IAM account: `access` in `admin` mode behind a shared-fence
 * answer. A caller whose plan does not reach `target` (no grant, no binding, Root, absent id)
 * gets `false` without taking the exclusive fence or advancing the revision; the exclusive step
 * decides again, so the pre-check is only a hint. Inside it, one lookup through `account_directory`
 * answers an absent id and any Root alike with `false`, and only then is oneself a 403.
 */
export class AdminAccountCommand {
  private readonly gateway: ProductDataGateway;

  constructor(
    private readonly authority: ProductAuthorization,
    private readonly bindings: ProductBindingRegistry,
  ) {
    this.gateway = new ProductDataGateway(bindings);
  }

  async run(
    secret: string,
    action: string,
    target: string,
    work: (
      plan: UserAuthorizedPlan,
      tx: ProductTransaction,
      kind: PrincipalKind,
    ) => Promise<boolean>,
    rootEvent: (plan: UserAuthorizedPlan, done: boolean) => ProductAuditEvent | undefined,
  ): Promise<boolean> {
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
        return work(plan, tx, kind);
      },
      rootEvent,
    );
  }
}

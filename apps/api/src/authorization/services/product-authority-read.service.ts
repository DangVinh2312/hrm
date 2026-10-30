import type { PermitProbe, PermitQuery } from '../helpers/permit-probe.helper.js';
import {
  ProductDataGateway,
  ProductInvalidRequest,
  type ListQuery,
} from '../product-data.gateway.js';
import { compilePlan, quoteIdentifier } from '../product-sql.compiler.js';
import { isPermitProbe, validPermitQueries } from '../helpers/permit-probe.helper.js';
import type { ProductTransaction } from '../../database/product-transaction.runner.js';
import type { ProductTransactionRunner } from '../../database/product-transaction.runner.js';
import type { ProductAuditEvent } from '../../audit/product-audit.repository.js';
import { type ProductAuthorityEngine, requestKey } from './product-authority-engine.service.js';
import {
  ProductAccessDenied,
  type ProductQuery,
  type SessionProjection,
} from './product-authority.types.js';

const ok = { principalKind: 'root', outcome: 'ok' } as const;

/** Reads of one fenced transaction: record reads through the gateway, registered queries and menu probes. */
export class ProductAuthorityReads {
  constructor(
    private readonly engine: ProductAuthorityEngine,
    private readonly transactions: ProductTransactionRunner,
    private readonly gateway: ProductDataGateway,
    private readonly queries: ReadonlySet<ProductQuery<never, unknown>>,
  ) {}

  private get bindings() {
    return this.engine.bindings;
  }

  /**
   * Whether the session's plan for `resource.action` reaches at least one record right now: the
   * menus (design §10.2) and the decision to deliver a report file (`ReportService.export`, which
   * checks it again before the response; an empty scope is refused with 403, never an empty file). A plan without any grant is still `allow` with a predicate that matches nothing
   * (record exceptions aside), so the decision alone cannot tell; one EXISTS on the bound table
   * can. Display only: it returns no row data, fulfils no obligation and every operation still
   * decides for itself.
   */
  async permits(secret: string, resource: string, action: string): Promise<boolean> {
    return this.transactions.run('read', async (tx) => {
      const session = await this.engine.session(tx, secret);
      return this.reachesAny(tx, session, resource, action);
    });
  }

  /**
   * `permits` for several pairs in ONE transaction (menus): one fence, one
   * session resolution, then each pair decided and probed in order on the same `tx.manager`, so
   * every answer equals the single `permits` of its pair and all of them see the same facts.
   * An element may be an any-of group: its pairs run in order and stop at the first reachable one
   * (like `a || b` of two `permits`), the answer is that OR. At most MAX_PERMIT_PROBES pairs in
   * total (groups flattened), validated before any transaction; unknown pairs answer `false`.
   */
  async permitsMany(secret: string, queries: readonly PermitQuery[]): Promise<boolean[]> {
    if (!validPermitQueries(queries)) throw new ProductInvalidRequest('Invalid permit probes');
    return this.transactions.run('read', async (tx) => {
      const session = await this.engine.session(tx, secret);
      const answers: boolean[] = [];
      for (const query of queries) {
        let reachable = false;
        const group: readonly PermitProbe[] = isPermitProbe(query) ? [query] : query;
        for (const { resource, action } of group) {
          reachable = await this.reachesAny(tx, session, resource, action, true);
          if (reachable) break;
        }
        answers.push(reachable);
      }
      return answers;
    });
  }

  /** `menu` is the `permitsMany` path: Root answers by the decision alone, so an empty table never hides the page Root fills it from. */
  private async reachesAny(
    tx: ProductTransaction,
    session: SessionProjection,
    resource: string,
    action: string,
    menu = false,
  ): Promise<boolean> {
    const decision = await this.engine.decide(tx, session, resource, action, menu);
    if (decision.effect !== 'allow') return false;
    if (menu && session.kind === 'root') return true;
    const binding = this.bindings.resource(resource);
    const bound = compilePlan(decision.plan, this.bindings);
    const [row] = await tx.manager.query<{ reachable: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(binding.table)} r WHERE ${bound.sql}) AS reachable`,
      [...bound.parameters],
    );
    return row?.reachable === true;
  }

  list(secret: string, resource: string, action: string, query: ListQuery = {}) {
    return this.engine.access(
      secret,
      resource,
      action,
      'read',
      (plan, tx) => this.gateway.list(plan, query, tx),
      (plan) => ({
        kind: `access.${plan.resource}.${plan.action}`,
        actor: plan.userId,
        permission: plan.permission,
        ...ok,
      }),
    );
  }

  detail(secret: string, resource: string, action: string, key: string) {
    return this.engine.access(
      secret,
      resource,
      action,
      'read',
      (plan, tx) =>
        this.gateway.detail(
          plan,
          requestKey(
            this.bindings.core,
            this.bindings.declarations.resources[resource]!.keyKind,
            key,
          ),
          tx,
        ),
      (plan, row): ProductAuditEvent => ({
        kind: `access.${plan.resource}.${plan.action}`,
        actor: plan.userId,
        permission: plan.permission,
        principalKind: 'root',
        outcome: row ? 'ok' : 'absent',
        target: this.engine.requested(resource, key),
      }),
    );
  }

  count(secret: string, resource: string, action: string) {
    return this.engine.access(
      secret,
      resource,
      action,
      'read',
      (plan, tx) => this.gateway.count(plan, {}, tx),
      (plan) => ({
        kind: `access.${plan.resource}.${plan.action}`,
        actor: plan.userId,
        permission: plan.permission,
        ...ok,
      }),
    );
  }

  /**
   * Runs a registered query in one fenced read transaction: session, facts and plan, then `run`
   * with the plan's predicate. Root reads leave one `access.*` event (absent when a detail query
   * returns `undefined`).
   */
  async query<I, R>(secret: string, query: ProductQuery<I, R>, input: I): Promise<R> {
    if (!this.queries.has(query)) throw new ProductAccessDenied();
    const { resource, action } = query;
    const key = query.target?.(input);
    if (key !== undefined)
      requestKey(this.bindings.core, this.bindings.declarations.resources[resource]!.keyKind, key);
    return this.engine.access(
      secret,
      resource,
      action,
      'read',
      (plan, tx, kind) => {
        const bound = compilePlan(plan, this.bindings);
        return query.run(
          {
            tx,
            actor: { id: plan.userId, kind },
            scope: { sql: bound.sql, parameters: [...bound.parameters] },
          },
          input,
        );
      },
      (plan, result) => ({
        kind: `access.${plan.resource}.${plan.action}`,
        actor: plan.userId,
        permission: plan.permission,
        principalKind: 'root',
        outcome: key !== undefined && result === undefined ? 'absent' : 'ok',
        ...(key !== undefined ? { target: this.engine.requested(resource, key) } : {}),
      }),
    );
  }
}

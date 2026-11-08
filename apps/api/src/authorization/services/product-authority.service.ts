import type {
  UserAuthorizedPlan,
  UserAuthoritySnapshot,
  Scalar,
} from '../core/authorization.types.js';
import type { PrincipalKind } from '../product-principal.types.js';
import type {
  ProductTransactionRunner,
  ProductTransaction,
} from '../../database/product-transaction.runner.js';
import type { ProductBindingRegistry } from '../product-sql.compiler.js';
import { ProductDataGateway, type ListQuery } from '../product-data.gateway.js';
import type {
  ProductAuditEvent,
  ProductAuditRepository,
} from '../../audit/product-audit.repository.js';
import type { PermitQuery } from '../helpers/permit-probe.helper.js';
import { ProductAuthorityEngine } from './product-authority-engine.service.js';
import { ProductAuthorityReads } from './product-authority-read.service.js';
import { ProductAuthorityWrites } from './product-authority-write.service.js';
import type { ProductObligationRegistry } from './product-obligation.service.js';
import type {
  ProductCommand,
  ProductQuery,
  ProductResourceWrite,
  SessionProjection,
} from './product-authority.types.js';

/** Public service owns session, facts, plan and effects in one transaction; callers cannot supply a plan. */
export class ProductAuthorization {
  private readonly engine: ProductAuthorityEngine;
  private readonly reads: ProductAuthorityReads;
  private readonly writes: ProductAuthorityWrites;

  /** Obligation handlers are fixed at composition (frozen copy); core sees exactly their names. */
  constructor(
    transactions: ProductTransactionRunner,
    audit: ProductAuditRepository,
    bindings: ProductBindingRegistry,
    capabilities: {
      readonly validators: UserAuthoritySnapshot['registry']['validators'];
      readonly obligations: ProductObligationRegistry;
    },
    writable: readonly ProductResourceWrite[] = [],
    commands: readonly ProductCommand<never, unknown>[] = [],
    queries: readonly ProductQuery<never, unknown>[] = [],
  ) {
    for (const operation of [...commands, ...queries]) {
      const declared = Object.hasOwn(bindings.declarations.resources, operation.resource)
        ? bindings.declarations.resources[operation.resource]
        : undefined;
      if (!declared || !Object.hasOwn(declared.actions, operation.action))
        throw new TypeError(
          `Operation for undeclared permission ${operation.resource}.${operation.action}`,
        );
    }
    const obligations = Object.freeze({ ...capabilities.obligations });
    this.engine = new ProductAuthorityEngine(
      transactions,
      audit,
      bindings,
      {
        validators: capabilities.validators,
        obligationHandlers: Object.freeze(Object.keys(obligations)),
      },
      obligations,
    );
    this.reads = new ProductAuthorityReads(
      this.engine,
      transactions,
      new ProductDataGateway(bindings),
      new Set(queries),
    );
    this.writes = new ProductAuthorityWrites(this.engine, audit, writable, new Set(commands));
  }

  permits(secret: string, resource: string, action: string): Promise<boolean> {
    return this.reads.permits(secret, resource, action);
  }

  permitsMany(secret: string, queries: readonly PermitQuery[]): Promise<boolean[]> {
    return this.reads.permitsMany(secret, queries);
  }

  /**
   * Public only for the command services built from this instance at composition
   * (`ProductAccountService`); the HTTP ports expose bound operations, never this.
   */
  access<T>(
    secret: string,
    resource: string,
    action: string,
    mode: 'read' | 'write' | 'admin',
    work: (
      plan: UserAuthorizedPlan,
      tx: ProductTransaction,
      kind: PrincipalKind,
      session: SessionProjection,
    ) => Promise<T>,
    /** `undefined` only when `work` already wrote the Root-marked event (commands). */
    rootEvent: (plan: UserAuthorizedPlan, result: T) => ProductAuditEvent | undefined,
  ): Promise<T> {
    return this.engine.access(secret, resource, action, mode, work, rootEvent);
  }

  /** Public for `ProductAccountService`, whose `admin` commands cannot go through `execute`. */
  reachesTarget(secret: string, resource: string, action: string, key: string): Promise<boolean> {
    return this.engine.reachesTarget(secret, resource, action, key);
  }

  /** Public for `ProductAccountService`: the shared-fence answer before provisioning. */
  allowsAll(
    secret: string,
    pairs: readonly { readonly resource: string; readonly action: string }[],
  ): Promise<boolean> {
    return this.engine.allowsAll(secret, pairs);
  }

  /** Public for `ProductAccountService`: a second permission's reach inside its `access`. */
  reachesIn(
    tx: ProductTransaction,
    session: SessionProjection,
    resource: string,
    action: string,
    key: string,
    fulfil = false,
  ): Promise<boolean> {
    return this.engine.reachesIn(tx, session, resource, action, key, fulfil);
  }

  list(secret: string, resource: string, action: string, query: ListQuery = {}) {
    return this.reads.list(secret, resource, action, query);
  }

  detail(secret: string, resource: string, action: string, key: string) {
    return this.reads.detail(secret, resource, action, key);
  }

  count(secret: string, resource: string, action: string) {
    return this.reads.count(secret, resource, action);
  }

  update(
    secret: string,
    resource: string,
    action: string,
    key: string,
    changes: Readonly<Record<string, Scalar>>,
  ): Promise<boolean> {
    return this.writes.update(secret, resource, action, key, changes);
  }

  execute<I, R>(secret: string, command: ProductCommand<I, R>, input: I): Promise<R | undefined> {
    return this.writes.execute(secret, command, input);
  }

  query<I, R>(secret: string, query: ProductQuery<I, R>, input: I): Promise<R> {
    return this.reads.query(secret, query, input);
  }
}

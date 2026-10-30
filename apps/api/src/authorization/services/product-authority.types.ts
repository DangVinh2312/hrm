import type { UserId } from '../core/authorization.types.js';
import type { PrincipalKind } from '../product-principal.types.js';
import type { ProductTransaction } from '../../database/product-transaction.runner.js';
import type { ProductModuleAuditKind } from '../../audit/product-audit.repository.js';
import type {
  ProductPermissionAuditDetail,
  ProductPermissionAuditKind,
} from '../../audit/product-audit-detail.helper.js';

export class ProductAccessDenied extends Error {
  constructor() {
    super('Access denied');
  }
}

export interface SessionProjection {
  user_id: UserId;
  /** From resolve_session in this fenced transaction; never from a request or a role name. */
  kind: PrincipalKind;
  assurance: string;
  authenticated_at: Date;
  reauthenticated_at: Date | null;
  expires_at: Date;
  state: 'active' | 'suspended' | 'pending';
  /** PRODUCT_FRESH_AUTH_SQL, by the DB clock of the same statement. */
  fresh: boolean;
  /** DB clock of the same statement and the plan deadline (never past session expiry). */
  now: string;
  deadline: string;
  /** expires_at at microsecond precision (a JS Date would truncate it). */
  expires_text: string;
}

export interface ProductResourceWrite {
  readonly resource: string;
  readonly action: string;
  readonly fields: readonly string[];
}

/** Acting principal of a command; `kind` is the verified session kind of this transaction. */
export interface ProductCommandActor {
  readonly id: UserId;
  readonly kind: PrincipalKind;
}

export interface ProductCommandContext {
  readonly tx: ProductTransaction;
  readonly actor: ProductCommandActor;
  readonly permission: string;
  /**
   * The authorized record (the parent for a create), locked FOR NO KEY UPDATE by the statement
   * that matched the plan, so the predicate held on the locked row and holds until commit.
   */
  readonly target: { readonly key: string; readonly objectId: string };

  /**
   * Whether this session's plan for `resource.action` reaches the record `key` right now, in this
   * transaction (grants, policy scope, denies and boundaries all included; read-only, nothing
   * is audited or fulfilled). A command uses it to make a business rule that needs a second
   * permission (the COO's self-approval needs `workRequest.decideFinal` on the new request) obey
   * the same policy as the operation that normally does it.
   */
  readonly reaches: (resource: string, action: string, key: string) => Promise<boolean>;

  /** Appends the typed effect event in this transaction; Root events carry the Root marker. */
  readonly audit: {
    (kind: ProductModuleAuditKind, target: ProductAuditTarget): Promise<void>;

    (
      kind: ProductPermissionAuditKind,
      target: ProductAuditTarget,
      detail?: ProductPermissionAuditDetail,
    ): Promise<void>;
  };
}

export type ProductAuditTarget = {
  readonly resource: string;
  readonly key: string;
  readonly objectId: string;
};

/**
 * Code-owned command fixed at composition, never built from a request: the
 * permission checked on an existing record and the work done after it in the same transaction.
 * `run` holds the business guards that also apply to Root (stage order, no self decision) and
 * must audit its effect; it may only do rollback-safe DB work (the runner can re-run it).
 */
export interface ProductCommand<I, R> {
  readonly resource: string;
  readonly action: string;
  readonly mode: 'write' | 'admin';

  /** Key of the authorized record, from input the command already validated. */
  readonly target: (input: I) => string;

  readonly run: (context: ProductCommandContext, input: I) => Promise<R>;
}

/** Authorized predicate of a plan over alias `r` of the resource table, parameters $1…$n. */
export interface ProductScope {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export interface ProductQueryContext {
  readonly tx: ProductTransaction;
  readonly actor: ProductCommandActor;
  readonly scope: ProductScope;
}

/**
 * Code-owned read fixed at composition, like ProductCommand: `run` must AND `scope`
 * into the WHERE of the resource table aliased `r`, before any aggregate or pagination, and add
 * its own parameters after `scope.parameters`. Rows it joins are fields of the authorized record
 * (design §5.1), never records of another resource. Needed where the fixed gateway projection
 * cannot express the read (business dates as text, history rows, per-record aggregates).
 */
export interface ProductQuery<I, R> {
  readonly resource: string;
  readonly action: string;

  /** Requested key of a detail read (Root audit target; `undefined` result = absent). */
  readonly target?: (input: I) => string;

  readonly run: (context: ProductQueryContext, input: I) => Promise<R>;
}

/** The command's business rules refused the request (stale version, wrong state…): HTTP 409. */
export class ProductCommandRejected extends Error {
  constructor(readonly reason: string) {
    super(`Command rejected: ${reason}`);
  }
}

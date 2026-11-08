import type { AuthorizationCore } from '../core/authorization.factory.js';
import type {
  KeyKind,
  UserAuthoritySnapshot,
  UserAuthorizedPlan,
  UserTrustedInput,
} from '../core/authorization.types.js';
import type { PrincipalKind } from '../product-principal.types.js';
import type {
  ProductTransactionRunner,
  ProductTransaction,
} from '../../database/product-transaction.runner.js';
import {
  type ProductBindingRegistry,
  compilePlan,
  keyPgTypes,
  quoteIdentifier,
} from '../product-sql.compiler.js';
import { ProductInvalidRequest } from '../product-data.gateway.js';
import {
  sessionDigest,
  PRODUCT_FRESH_AUTH_SQL,
  ProductAuthenticationError,
} from '../../authentication/services/product-identity.service.js';
import type {
  ProductAuditEvent,
  ProductAuditRepository,
} from '../../audit/product-audit.repository.js';
import { ProductAuthorityFactsRepository } from '../repositories/product-authority-facts.repository.js';
import {
  fulfillProductObligations,
  type ProductObligationRegistry,
} from './product-obligation.service.js';
import { ProductAccessDenied, type SessionProjection } from './product-authority.types.js';

const utc = (expression: string) =>
  `to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** SessionProjection over `resolve_session` aliased `s`, clock of the same statement. */
const sessionColumns = `s.user_id,s.kind,s.state,s.assurance,s.authenticated_at,s.reauthenticated_at,s.expires_at,${PRODUCT_FRESH_AUTH_SQL} fresh,${utc('statement_timestamp()')} now,${utc("LEAST(s.expires_at,statement_timestamp()+interval '2 seconds')")} deadline`;

/** Request keys come from callers: a malformed key is invalid input, not a server fault. */
export function requestKey(core: AuthorizationCore, kind: KeyKind, key: string) {
  try {
    return core.parseKey(kind, key);
  } catch {
    throw new ProductInvalidRequest('Malformed key');
  }
}

/** Session, facts and plan of one fenced transaction; the only place that picks the Root plan. */
export class ProductAuthorityEngine {
  readonly #facts = new ProductAuthorityFactsRepository();

  constructor(
    private readonly transactions: ProductTransactionRunner,
    private readonly audit: ProductAuditRepository,
    readonly bindings: ProductBindingRegistry,
    private readonly registry: UserAuthoritySnapshot['registry'],
    private readonly obligations: ProductObligationRegistry,
  ) {}

  /**
   * The verified session of `secret` and one decision per pair, from ONE statement after the
   * fence (session row and the facts of its own user). `now`/`deadline` of every plan come from
   * that statement: a 2 s window, never past the session expiry.
   */
  async authorize(
    tx: ProductTransaction,
    secret: string,
    pairs: readonly { readonly resource: string; readonly action: string }[],
  ) {
    const found = await this.#facts.readSession<SessionProjection>(
      tx,
      sessionDigest(secret),
      sessionColumns,
      pairs.map(({ resource, action }) => `${resource}.${action}`),
      this.bindings.declarations,
      this.registry,
    );
    if (
      !found ||
      !this.bindings.core.isCanonicalUuid(found.session.user_id) ||
      (found.session.kind !== 'root' && found.session.kind !== 'iam')
    )
      throw new ProductAuthenticationError();
    const row = found.session;
    const session: SessionProjection = {
      user_id: row.user_id,
      kind: row.kind,
      state: row.state,
      assurance: row.assurance,
      authenticated_at: row.authenticated_at,
      reauthenticated_at: row.reauthenticated_at,
      expires_at: row.expires_at,
      fresh: row.fresh,
      now: row.now,
      deadline: row.deadline,
    };
    const decisions = pairs.map(({ resource, action }, index) =>
      this.#plan(session, resource, action, found.snapshots[index]!),
    );
    return { session, decisions };
  }

  /** Plan of `resource.action` for an already verified session of `tx` (its window). */
  async decide(
    tx: ProductTransaction,
    session: SessionProjection,
    resource: string,
    action: string,
  ) {
    const snapshot = await this.#facts.read(
      tx,
      session.user_id,
      `${resource}.${action}`,
      this.bindings.declarations,
      this.registry,
    );
    return this.#plan(session, resource, action, snapshot);
  }

  /** Root through planUnrestricted, only when `kind` comes from the verified session. */
  #plan(
    session: SessionProjection,
    resource: string,
    action: string,
    snapshot: UserAuthoritySnapshot,
  ) {
    const input: UserTrustedInput = {
      principal: { id: session.user_id, assurance: session.assurance === 'mfa' ? 2 : 1 },
      resource,
      action,
      now: session.now,
      validUntil: session.deadline,
      context: { freshAuthentication: session.fresh },
    };
    return session.kind === 'root'
      ? this.bindings.core.planUnrestricted(input, snapshot)
      : this.bindings.core.planUser(input, snapshot);
  }

  /**
   * The only Root branch: `kind` comes from the verified session. Root still needs a
   * valid session, a declared action, the context requirements of its policy (fresh
   * reauthentication only where the policy has `fresh@1`; `fresh` comes from the same
   * SQL session row as for IAM), the projection and writable allowlists, and leaves one audit
   * event per committed access.
   */
  async access<T>(
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
    return this.transactions.run(mode, async (tx) => {
      // Authority purpose deliberately has no session/credential read capability: use the narrow projection function.
      const { session, decisions } = await this.authorize(tx, secret, [{ resource, action }]);
      const [decision] = decisions;
      if (decision?.effect !== 'allow') throw new ProductAccessDenied();
      const result = await work(decision.plan, tx, session.kind, session);
      if (session.kind === 'root') {
        const event = rootEvent(decision.plan, result);
        if (event) await this.audit.appendProductAudit(tx, event);
      }
      await fulfillProductObligations(tx, decision.plan, this.obligations);
      return result;
    });
  }

  /** Requested key of a Root audit target (spec 6.5); parsed like the operation parsed it. */
  requested(resource: string, key: string) {
    const keyKind = this.bindings.declarations.resources[resource]!.keyKind;
    return { resource, keyKind, key: requestKey(this.bindings.core, keyKind, key).value };
  }

  /**
   * Shared-fence answer for an `admin` command before it takes the exclusive fence: an IAM
   * caller whose plan does not reach the target (no grant, wrong scope, absent record) is
   * answered here and never advances the revision. Only a hint: the exclusive step decides again.
   * Root always proceeds, it leaves its audit event there.
   */
  async reachesTarget(
    secret: string,
    resource: string,
    action: string,
    key: string,
  ): Promise<boolean> {
    return this.transactions.run('read', async (tx) => {
      const { session, decisions } = await this.authorize(tx, secret, [{ resource, action }]);
      if (session.kind === 'root') return true;
      const [decision] = decisions;
      if (decision?.effect !== 'allow') throw new ProductAccessDenied();
      return this.#reaches(tx, decision.plan, resource, key);
    });
  }

  /**
   * Shared-fence answer for an `admin` command whose target does not exist yet: whether every
   * pair is allowed. Only a hint, like `reachesTarget`: the exclusive step decides again.
   */
  async allowsAll(
    secret: string,
    pairs: readonly { readonly resource: string; readonly action: string }[],
  ): Promise<boolean> {
    return this.transactions.run('read', async (tx) => {
      const { decisions } = await this.authorize(tx, secret, pairs);
      return decisions.every((decision) => decision.effect === 'allow');
    });
  }

  /**
   * Whether the plan of `resource.action` for the verified `session` of `tx` reaches `key`.
   * `fulfil` runs that plan's obligations when it does: for a second permission that writes.
   */
  async reachesIn(
    tx: ProductTransaction,
    session: SessionProjection,
    resource: string,
    action: string,
    key: string,
    fulfil = false,
  ): Promise<boolean> {
    const decision = await this.decide(tx, session, resource, action);
    if (decision.effect !== 'allow' || !(await this.#reaches(tx, decision.plan, resource, key)))
      return false;
    if (fulfil) await fulfillProductObligations(tx, decision.plan, this.obligations);
    return true;
  }

  async #reaches(
    tx: ProductTransaction,
    plan: UserAuthorizedPlan,
    resource: string,
    key: string,
  ): Promise<boolean> {
    const binding = this.bindings.resource(resource);
    const keyKind = this.bindings.declarations.resources[resource]!.keyKind;
    const bound = compilePlan(plan, this.bindings);
    const parameters = [...bound.parameters, requestKey(this.bindings.core, keyKind, key).value];
    const [row] = await tx.manager.query<{ reachable: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(binding.table)} r WHERE ${bound.sql} AND r.${quoteIdentifier(binding.keyColumn)}=CAST($${parameters.length} AS ${keyPgTypes[keyKind]})) AS reachable`,
      parameters,
    );
    return row?.reachable === true;
  }
}

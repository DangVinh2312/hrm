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

  async session(tx: ProductTransaction, secret: string): Promise<SessionProjection> {
    const [session] = await tx.manager.query<SessionProjection[]>(
      `SELECT s.user_id,s.kind,s.state,s.assurance,s.authenticated_at,s.reauthenticated_at,s.expires_at,${PRODUCT_FRESH_AUTH_SQL} fresh,to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') now,to_char(LEAST(s.expires_at,statement_timestamp()+interval '2 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') deadline,to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') expires_text FROM public.resolve_session($1) s`,
      [sessionDigest(secret)],
    );
    if (
      !session ||
      !this.bindings.core.isCanonicalUuid(session.user_id) ||
      (session.kind !== 'root' && session.kind !== 'iam')
    )
      throw new ProductAuthenticationError();
    return session;
  }

  /**
   * Plan of `resource.action` for the verified session of `tx`; Root through planUnrestricted.
   * `renew`: take `now`/`deadline` from this pair's own facts statement (2 s window from it, still
   * capped by the session expiry) instead of the session statement's, for batches (`permitsMany`).
   */
  async decide(
    tx: ProductTransaction,
    session: SessionProjection,
    resource: string,
    action: string,
    renew = false,
  ) {
    const { snapshot, clock } = await this.#facts.readWithClock(
      tx,
      session.user_id,
      `${resource}.${action}`,
      this.bindings.declarations,
      this.registry,
      renew ? session.expires_text : null,
    );
    const window = renew ? clock : session;
    const input: UserTrustedInput = {
      principal: { id: session.user_id, assurance: session.assurance === 'mfa' ? 2 : 1 },
      resource,
      action,
      now: window.now,
      validUntil: window.deadline,
      context: { freshAuthentication: session.fresh },
    };
    return session.kind === 'root'
      ? this.bindings.core.planUnrestricted(input, snapshot)
      : this.bindings.core.planUser(input, snapshot);
  }

  async checkSession(secret: string): Promise<void> {
    await this.transactions.run('read', async (tx) => {
      await this.session(tx, secret);
    });
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
      const session = await this.session(tx, secret);
      const decision = await this.decide(tx, session, resource, action);
      if (decision.effect !== 'allow') throw new ProductAccessDenied();
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
      const session = await this.session(tx, secret);
      if (session.kind === 'root') return true;
      const decision = await this.decide(tx, session, resource, action);
      if (decision.effect !== 'allow') throw new ProductAccessDenied();
      const binding = this.bindings.resource(resource);
      const keyKind = this.bindings.declarations.resources[resource]!.keyKind;
      const bound = compilePlan(decision.plan, this.bindings);
      const parameters = [...bound.parameters, requestKey(this.bindings.core, keyKind, key).value];
      const [row] = await tx.manager.query<{ reachable: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(binding.table)} r WHERE ${bound.sql} AND r.${quoteIdentifier(binding.keyColumn)}=CAST($${parameters.length} AS ${keyPgTypes[keyKind]})) AS reachable`,
        parameters,
      );
      return row?.reachable === true;
    });
  }
}

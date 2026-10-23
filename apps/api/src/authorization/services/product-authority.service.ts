import { randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import type { AuthorizationCore } from '../core/authorization.factory.js';
import type {
  KeyKind,
  UserId,
  UserAuthoritySnapshot,
  UserAuthorizedPlan,
  UserTrustedInput,
  Scalar,
} from '../core/authorization.types.js';
import type { ValidatedDeclarations } from '../core/authorization.declarations.js';
import {
  ProductTransactionRunner,
  type ProductTransaction,
} from '../../database/product-transaction.runner.js';
import {
  ProductBindingRegistry,
  compilePlan,
  quoteIdentifier,
  fieldPgTypes,
  keyPgTypes,
} from '../product-sql.compiler.js';
import {
  ProductDataGateway,
  ProductInvalidRequest,
  type ListQuery,
  type Row,
} from '../product-data.gateway.js';
import {
  canonicalLoginEmail,
  sessionDigest,
  PRODUCT_FRESH_AUTH_SQL,
  ProductAuthenticationError,
} from '../../authentication/services/product-identity.service.js';
import {
  type ProductAuditEvent,
  type ProductAuditRepository,
  type ProductHrAuditKind,
} from '../../audit/product-audit.repository.js';
import {
  isPermitProbe,
  validPermitQueries,
  type PermitProbe,
  type PermitQuery,
} from '../helpers/permit-probe.helper.js';
import {
  fulfillProductObligations,
  type ProductObligationRegistry,
} from './product-obligation.service.js';

export class ProductAccessDenied extends Error {
  constructor() {
    super('Access denied');
  }
}

/** Request keys come from callers: a malformed key is invalid input, not a server fault. */
function requestKey(core: AuthorizationCore, kind: KeyKind, key: string) {
  try {
    return core.parseKey(kind, key);
  } catch {
    throw new ProductInvalidRequest('Malformed key');
  }
}

interface SessionProjection {
  user_id: UserId;
  /** From resolve_session in this fenced transaction; never from a request or a role name. */
  kind: 'root' | 'iam';
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
type PrincipalKind = SessionProjection['kind'];
type Lifecycle = 'active' | 'deprecated' | 'retired';

/**
 * Facts of one user for one permission, read in one statement after the fence. The planner only
 * consults the catalog row, rules and boundary bindings of the requested permission, so rows of
 * other permissions are not loaded; user and all roles are (roles feed record exceptions).
 */
export async function readProductAuthority(
  tx: ProductTransaction,
  userId: UserId,
  permission: string,
  declarations: ValidatedDeclarations,
  registry: UserAuthoritySnapshot['registry'],
): Promise<UserAuthoritySnapshot> {
  return (await readAuthority(tx, userId, permission, declarations, registry, null)).snapshot;
}

/**
 * `readProductAuthority` plus the DB clock of the same statement: `now` and a `deadline` of
 * 2 s from it, never past `expiresAt` (the session's expiry; null when the caller keeps the
 * session statement's window). Lets `permitsMany` renew the window per pair without a round trip.
 */
async function readAuthority(
  tx: ProductTransaction,
  userId: UserId,
  permission: string,
  declarations: ValidatedDeclarations,
  registry: UserAuthoritySnapshot['registry'],
  expiresAt: string | null,
): Promise<{ snapshot: UserAuthoritySnapshot; clock: { now: string; deadline: string } }> {
  const [facts] = await tx.manager.query<
    {
      user: { id: UserId; state: 'active' | 'suspended' | 'pending' } | null;
      roles: string[];
      permissions: {
        key: string;
        resource: string;
        action: string;
        policy_key: string;
        policy_version: number;
        lifecycle: Lifecycle;
        boundary: 'required' | 'optional' | null;
      }[];
      rules: {
        id: string;
        permission: string;
        user_id: UserId | null;
        role: string | null;
        effect: 'allow' | 'deny';
        template: string;
        version: number;
        parameters: Record<string, Scalar>;
      }[];
      boundaries: { permission: string; key: string; version: number; lifecycle: Lifecycle }[];
      clock: { now: string; deadline: string };
    }[]
  >(
    `SELECT
      (SELECT json_build_object('id',id,'state',state) FROM app_user WHERE id=$1) "user",
      ARRAY(SELECT convert_from(role_key,'UTF8') FROM user_role WHERE user_id=$1 ORDER BY role_key) roles,
      (SELECT COALESCE(json_agg(json_build_object('key',convert_from(permission_key,'UTF8'),'resource',convert_from(type_key,'UTF8'),'action',convert_from(action_key,'UTF8'),'policy_key',convert_from(policy_key,'UTF8'),'policy_version',policy_version,'lifecycle',lifecycle,'boundary',boundary_requirement)),'[]')
        FROM permission_catalog WHERE permission_key=convert_to($2,'UTF8')) permissions,
      (SELECT COALESCE(json_agg(json_build_object('id',rule_id,'permission',convert_from(permission_key,'UTF8'),'user_id',user_id,'role',convert_from(role_key,'UTF8'),'effect',effect,'template',convert_from(template_key,'UTF8'),'version',template_version,'parameters',parameters) ORDER BY rule_id),'[]')
        FROM policy_rule WHERE permission_key=convert_to($2,'UTF8') AND (user_id=$1 OR role_key IN(SELECT role_key FROM user_role WHERE user_id=$1))) rules,
      (SELECT COALESCE(json_agg(json_build_object('permission',convert_from(b.permission_key,'UTF8'),'key',convert_from(b.boundary_key,'UTF8'),'version',b.boundary_version,'lifecycle',d.lifecycle)),'[]')
        FROM user_boundary b JOIN permission_boundary d USING(boundary_key,boundary_version) WHERE b.user_id=$1 AND b.permission_key=convert_to($2,'UTF8')) boundaries,
      json_build_object('now',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'deadline',to_char(LEAST($3::timestamptz,statement_timestamp()+interval '2 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) clock`,
    [userId, permission, expiresAt],
  );
  if (!facts) throw new Error('Authority statement returned no row');
  const snapshot: UserAuthoritySnapshot = {
    revision: tx.revision,
    declarations,
    registry,
    user: facts.user ?? undefined,
    roles: facts.roles,
    permissions: facts.permissions.map((p) => ({
      ...p,
      policy: { key: p.policy_key, version: p.policy_version },
    })),
    rules: facts.rules.map((r) => ({
      id: r.id,
      permission: r.permission,
      subject: r.user_id
        ? { kind: 'identity', identity: r.user_id }
        : { kind: 'role', role: r.role ?? '' },
      effect: r.effect,
      template: { key: r.template, version: r.version },
      parameters: r.parameters,
    })),
    boundaries: facts.boundaries.map((b) => ({
      identity: userId,
      permission: b.permission,
      boundary: { key: b.key, version: b.version },
      lifecycle: b.lifecycle,
    })),
  };
  return { snapshot, clock: facts.clock };
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
  readonly audit: (kind: ProductHrAuditKind, target: ProductAuditTarget) => Promise<void>;
}

export type ProductAuditTarget = {
  readonly resource: string;
  readonly key: string;
  readonly objectId: string;
};

/**
 * Code-owned command fixed at composition (ADR 0016 §1), never built from a request: the
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
 * Code-owned read fixed at composition, like ProductCommand (ADR 0016 §1): `run` must AND `scope`
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

/** Public service owns session, facts, plan and effects in one transaction; callers cannot supply a plan. */
export class ProductAuthorization {
  private readonly gateway: ProductDataGateway;
  private readonly registry: UserAuthoritySnapshot['registry'];
  private readonly obligations: ProductObligationRegistry;
  /** Commands registered at composition; `execute` refuses any other object. */
  private readonly commands: ReadonlySet<ProductCommand<never, unknown>>;
  /** Queries registered at composition; `query` refuses any other object. */
  private readonly queries: ReadonlySet<ProductQuery<never, unknown>>;

  /** Obligation handlers are fixed at composition (frozen copy); core sees exactly their names. */
  constructor(
    private readonly transactions: ProductTransactionRunner,
    private readonly audit: ProductAuditRepository,
    private readonly bindings: ProductBindingRegistry,
    capabilities: {
      readonly validators: UserAuthoritySnapshot['registry']['validators'];
      readonly obligations: ProductObligationRegistry;
    },
    private readonly writable: readonly ProductResourceWrite[] = [],
    commands: readonly ProductCommand<never, unknown>[] = [],
    queries: readonly ProductQuery<never, unknown>[] = [],
  ) {
    this.gateway = new ProductDataGateway(bindings);
    for (const operation of [...commands, ...queries]) {
      const declared = Object.hasOwn(bindings.declarations.resources, operation.resource)
        ? bindings.declarations.resources[operation.resource]
        : undefined;
      if (!declared || !Object.hasOwn(declared.actions, operation.action))
        throw new TypeError(
          `Operation for undeclared permission ${operation.resource}.${operation.action}`,
        );
    }
    this.commands = new Set(commands);
    this.queries = new Set(queries);
    this.obligations = Object.freeze({ ...capabilities.obligations });
    this.registry = {
      validators: capabilities.validators,
      obligationHandlers: Object.freeze(Object.keys(this.obligations)),
    };
  }

  async checkSession(secret: string): Promise<void> {
    await this.transactions.run('read', async (tx) => {
      await this.session(tx, secret);
    });
  }

  private async session(tx: ProductTransaction, secret: string): Promise<SessionProjection> {
    const [session] = await tx.manager.query<SessionProjection[]>(
      `SELECT s.*,${PRODUCT_FRESH_AUTH_SQL} fresh,to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') now,to_char(LEAST(s.expires_at,statement_timestamp()+interval '2 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') deadline,to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') expires_text FROM public.resolve_session($1) s`,
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
  private async decide(
    tx: ProductTransaction,
    session: SessionProjection,
    resource: string,
    action: string,
    renew = false,
  ) {
    const { snapshot, clock } = await readAuthority(
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
      const session = await this.session(tx, secret);
      return this.reachesAny(tx, session, resource, action);
    });
  }

  /**
   * `permits` for several pairs in ONE transaction (menus, ADR 0017 addendum): one fence, one
   * session resolution, then each pair decided and probed in order on the same `tx.manager`, so
   * every answer equals the single `permits` of its pair and all of them see the same facts.
   * An element may be an any-of group: its pairs run in order and stop at the first reachable one
   * (like `a || b` of two `permits`), the answer is that OR. At most MAX_PERMIT_PROBES pairs in
   * total (groups flattened), validated before any transaction; unknown pairs answer `false`.
   */
  async permitsMany(secret: string, queries: readonly PermitQuery[]): Promise<boolean[]> {
    if (!validPermitQueries(queries)) throw new ProductInvalidRequest('Invalid permit probes');
    return this.transactions.run('read', async (tx) => {
      const session = await this.session(tx, secret);
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

  private async reachesAny(
    tx: ProductTransaction,
    session: SessionProjection,
    resource: string,
    action: string,
    renew = false,
  ): Promise<boolean> {
    const decision = await this.decide(tx, session, resource, action, renew);
    if (decision.effect !== 'allow') return false;
    const binding = this.bindings.resource(resource);
    const bound = compilePlan(decision.plan, this.bindings);
    const [row] = await tx.manager.query<{ reachable: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(binding.table)} r WHERE ${bound.sql}) AS reachable`,
      [...bound.parameters],
    );
    return row?.reachable === true;
  }

  /**
   * The only Root branch (ADR 0012): `kind` comes from the verified session. Root still needs a
   * valid session, a declared action, the context requirements of its policy (fresh
   * reauthentication only where the policy has `fresh@1`, ADR 0022; `fresh` comes from the same
   * SQL session row as for IAM), the projection and writable allowlists, and leaves one audit
   * event per committed access.
   */
  private async access<T>(
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
  private requested(resource: string, key: string) {
    const keyKind = this.bindings.declarations.resources[resource]!.keyKind;
    return { resource, keyKind, key: requestKey(this.bindings.core, keyKind, key).value };
  }

  private static readonly ok = { principalKind: 'root', outcome: 'ok' } as const;

  list(secret: string, resource: string, action: string, query: ListQuery = {}) {
    return this.access(
      secret,
      resource,
      action,
      'read',
      (plan, tx) => this.gateway.list(plan, query, tx),
      (plan) => ({
        kind: `access.${plan.resource}.${plan.action}`,
        actor: plan.userId,
        permission: plan.permission,
        ...ProductAuthorization.ok,
      }),
    );
  }

  detail(secret: string, resource: string, action: string, key: string) {
    return this.access(
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
      (plan, row) => ({
        kind: `access.${plan.resource}.${plan.action}`,
        actor: plan.userId,
        permission: plan.permission,
        principalKind: 'root',
        outcome: row ? 'ok' : 'absent',
        target: this.requested(resource, key),
      }),
    );
  }

  count(secret: string, resource: string, action: string) {
    return this.access(
      secret,
      resource,
      action,
      'read',
      (plan, tx) => this.gateway.count(plan, {}, tx),
      (plan) => ({
        kind: `access.${plan.resource}.${plan.action}`,
        actor: plan.userId,
        permission: plan.permission,
        ...ProductAuthorization.ok,
      }),
    );
  }

  async update(
    secret: string,
    resource: string,
    action: string,
    key: string,
    changes: Readonly<Record<string, Scalar>>,
  ): Promise<boolean> {
    const declaration = this.writable.find((r) => r.resource === resource && r.action === action);
    const fields = Object.keys(changes);
    if (!declaration || fields.length === 0 || fields.some((f) => !declaration.fields.includes(f)))
      throw new ProductAccessDenied();
    const objectId = await this.access(
      secret,
      resource,
      action,
      'write',
      async (plan, tx, kind) => {
        const binding = this.bindings.resource(resource);
        const bound = compilePlan(plan, this.bindings);
        const params = [...bound.parameters];
        const assignments = fields.map((f) => {
          const value = this.bindings.core.normalizeValue(
            this.bindings.declarations.resources[resource]!.fields[f]!.kind,
            changes[f],
          );
          if (value === undefined) throw new ProductAccessDenied();
          params.push(value);
          return `${quoteIdentifier(binding.columns[f]!)}=CAST($${params.length} AS ${fieldPgTypes[this.bindings.declarations.resources[resource]!.fields[f]!.kind]})`;
        });
        const keyKind = this.bindings.declarations.resources[resource]!.keyKind;
        const typedKey = requestKey(this.bindings.core, keyKind, key);
        params.push(typedKey.value);
        const rows = await tx.manager.query<{ object_id: string }[]>(
          `WITH updated AS(UPDATE ${quoteIdentifier(binding.table)} r SET ${assignments.join(',')} WHERE ${bound.sql} AND r.${quoteIdentifier(binding.keyColumn)}=CAST($${params.length} AS ${keyPgTypes[keyKind]}) RETURNING r.${quoteIdentifier(binding.objectIdColumn)} AS object_id) SELECT * FROM updated`,
          params,
        );
        if (rows.length && kind === 'iam')
          await this.audit.appendProductAudit(tx, {
            kind: 'data.update',
            actor: plan.userId,
            permission: plan.permission,
            target: { resource, keyKind, key: typedKey.value, objectId: rows[0]!.object_id },
          });
        return rows[0]?.object_id;
      },
      (plan, updated): ProductAuditEvent =>
        updated === undefined
          ? {
              kind: 'data.update',
              actor: plan.userId,
              permission: plan.permission,
              principalKind: 'root',
              outcome: 'absent',
              target: this.requested(resource, key),
            }
          : {
              kind: 'data.update',
              actor: plan.userId,
              permission: plan.permission,
              principalKind: 'root',
              outcome: 'ok',
              target: { ...this.requested(resource, key), objectId: updated },
            },
    );
    return objectId !== undefined;
  }

  /**
   * Runs a registered command: session, facts and plan in one fenced transaction, then the target
   * row is matched against the plan and locked in one statement, then `run`. Absent and
   * not-visible targets are both `undefined` (HTTP 404). Every committed command leaves at least
   * one typed audit event, so a command that forgets to audit rolls back.
   */
  async execute<I, R>(
    secret: string,
    command: ProductCommand<I, R>,
    input: I,
  ): Promise<R | undefined> {
    if (!this.commands.has(command)) throw new ProductAccessDenied();
    const { resource, action } = command;
    const key = command.target(input);
    const outcome = await this.access(
      secret,
      resource,
      action,
      command.mode,
      async (plan, tx, kind, session) => {
        let audited = false;
        const binding = this.bindings.resource(resource);
        const keyKind = this.bindings.declarations.resources[resource]!.keyKind;
        const typedKey = requestKey(this.bindings.core, keyKind, key);
        const bound = compilePlan(plan, this.bindings);
        const parameters = [...bound.parameters, typedKey.value];
        // Under READ COMMITTED the locking read re-checks the predicate on the newest row version.
        const [row] = await tx.manager.query<{ object_id: string }[]>(
          `SELECT r.${quoteIdentifier(binding.objectIdColumn)}::text AS object_id FROM ${quoteIdentifier(binding.table)} r WHERE ${bound.sql} AND r.${quoteIdentifier(binding.keyColumn)}=CAST($${parameters.length} AS ${keyPgTypes[keyKind]}) FOR NO KEY UPDATE OF r`,
          parameters,
        );
        if (!row) return { found: false } as const;
        const result = await command.run(
          {
            tx,
            actor: { id: plan.userId, kind },
            permission: plan.permission,
            target: { key: typedKey.value, objectId: row.object_id },
            reaches: async (otherResource, otherAction, otherKey) => {
              const other = await this.decide(tx, session, otherResource, otherAction);
              if (other.effect !== 'allow') return false;
              const otherBinding = this.bindings.resource(otherResource);
              const otherKind = this.bindings.declarations.resources[otherResource]!.keyKind;
              const otherBound = compilePlan(other.plan, this.bindings);
              const otherParameters = [
                ...otherBound.parameters,
                requestKey(this.bindings.core, otherKind, otherKey).value,
              ];
              const [found] = await tx.manager.query<{ reached: boolean }[]>(
                `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(otherBinding.table)} r WHERE ${otherBound.sql} AND r.${quoteIdentifier(otherBinding.keyColumn)}=CAST($${otherParameters.length} AS ${keyPgTypes[otherKind]})) AS reached`,
                otherParameters,
              );
              return found?.reached === true;
            },
            audit: async (eventKind, target) => {
              const declared = Object.hasOwn(this.bindings.declarations.resources, target.resource)
                ? this.bindings.declarations.resources[target.resource]
                : undefined;
              if (!declared) throw new TypeError(`Audit target ${target.resource} is undeclared`);
              const event = {
                kind: eventKind,
                actor: plan.userId,
                permission: plan.permission,
                target: {
                  resource: target.resource,
                  keyKind: declared.keyKind,
                  key: requestKey(this.bindings.core, declared.keyKind, target.key).value,
                  objectId: target.objectId,
                },
              };
              await this.audit.appendProductAudit(
                tx,
                kind === 'root' ? { ...event, principalKind: 'root', outcome: 'ok' } : event,
              );
              audited = true;
            },
          },
          input,
        );
        if (!audited) throw new Error(`Command ${resource}.${action} committed no audit event`);
        return { found: true, result } as const;
      },
      (plan, done) =>
        done.found
          ? undefined
          : {
              kind: `access.${plan.resource}.${plan.action}`,
              actor: plan.userId,
              permission: plan.permission,
              principalKind: 'root',
              outcome: 'absent',
              target: this.requested(resource, key),
            },
    );
    return outcome.found ? outcome.result : undefined;
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
    return this.access(
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
        ...(key !== undefined ? { target: this.requested(resource, key) } : {}),
      }),
    );
  }

  /**
   * account.provision (ADR 0020 §3): a pending IAM account with this email and a 7-day enrollment
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
    return this.access(
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

  async suspendUser(secret: string, target: string): Promise<boolean> {
    if (!this.bindings.core.isCanonicalUuid(target)) throw new ProductAccessDenied();
    return this.access(
      secret,
      'account',
      'suspend',
      'admin',
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
}

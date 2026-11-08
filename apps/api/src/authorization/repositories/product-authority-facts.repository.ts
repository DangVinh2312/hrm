import type { Scalar, UserAuthoritySnapshot, UserId } from '../core/authorization.types.js';
import type { ValidatedDeclarations } from '../core/authorization.declarations.js';
import type { ProductTransaction } from '../../database/product-transaction.runner.js';

type Lifecycle = 'active' | 'deprecated' | 'retired';

interface FactsRow {
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
}

/**
 * Facts of `s.user_id` for the permissions in `$2` (text[]). The planner only consults the
 * catalog row, rules and boundary bindings of the requested permission, so rows of other
 * permissions are not loaded; user and all roles are (roles feed record exceptions).
 */
const factsColumns = `
  (SELECT json_build_object('id',id,'state',state) FROM app_user WHERE id=s.user_id) "user",
  ARRAY(SELECT convert_from(role_key,'UTF8') FROM user_role WHERE user_id=s.user_id ORDER BY role_key) roles,
  (SELECT COALESCE(json_agg(json_build_object('key',convert_from(permission_key,'UTF8'),'resource',convert_from(type_key,'UTF8'),'action',convert_from(action_key,'UTF8'),'policy_key',convert_from(policy_key,'UTF8'),'policy_version',policy_version,'lifecycle',lifecycle,'boundary',boundary_requirement)),'[]')
    FROM permission_catalog WHERE permission_key=ANY(k.keys)) permissions,
  (SELECT COALESCE(json_agg(json_build_object('id',rule_id,'permission',convert_from(permission_key,'UTF8'),'user_id',user_id,'role',convert_from(role_key,'UTF8'),'effect',effect,'template',convert_from(template_key,'UTF8'),'version',template_version,'parameters',parameters) ORDER BY rule_id),'[]')
    FROM policy_rule WHERE permission_key=ANY(k.keys) AND (user_id=s.user_id OR role_key IN(SELECT role_key FROM user_role WHERE user_id=s.user_id))) rules,
  (SELECT COALESCE(json_agg(json_build_object('permission',convert_from(b.permission_key,'UTF8'),'key',convert_from(b.boundary_key,'UTF8'),'version',b.boundary_version,'lifecycle',d.lifecycle)),'[]')
    FROM user_boundary b JOIN permission_boundary d USING(boundary_key,boundary_version) WHERE b.user_id=s.user_id AND b.permission_key=ANY(k.keys)) boundaries`;

const keys = `(SELECT ARRAY(SELECT convert_to(p,'UTF8') FROM unnest(CAST($2 AS text[])) p) keys) k`;

export class ProductAuthorityFactsRepository {
  /** Facts of one user for one permission, read in one statement after the fence. */
  async read(
    tx: ProductTransaction,
    userId: UserId,
    permission: string,
    declarations: ValidatedDeclarations,
    registry: UserAuthoritySnapshot['registry'],
  ): Promise<UserAuthoritySnapshot> {
    const [facts] = await tx.manager.query<FactsRow[]>(
      `SELECT ${factsColumns} FROM (SELECT CAST($1 AS uuid) user_id) s, ${keys}`,
      [userId, [permission]],
    );
    if (!facts) throw new Error('Authority statement returned no row');
    return snapshotOf(tx, userId, facts, permission, declarations, registry);
  }

  /**
   * The session of `digest` (columns `sessionColumns` over `resolve_session` aliased `s`) and the
   * facts of its own user for each of `permissions`, in ONE statement after the fence: one
   * snapshot per permission, in order, each holding exactly the rows `read` would return for it.
   * `undefined` when the digest resolves no session. `session` is the whole row: callers pick the
   * session columns they selected.
   */
  async readSession<S extends { user_id: UserId }>(
    tx: ProductTransaction,
    digest: Buffer,
    sessionColumns: string,
    permissions: readonly string[],
    declarations: ValidatedDeclarations,
    registry: UserAuthoritySnapshot['registry'],
  ): Promise<{ session: S; snapshots: UserAuthoritySnapshot[] } | undefined> {
    // LIMIT 1 (token_hash is the key): unbounded, the function is estimated at 1000 rows, and the
    // per-row subplans push the cost past jit_above_cost, so every request paid ~1 s of JIT.
    const [row] = await tx.manager.query<(S & FactsRow)[]>(
      `SELECT ${sessionColumns},${factsColumns} FROM (SELECT user_id,kind,state,auth_epoch,method,assurance,authenticated_at,reauthenticated_at,expires_at FROM public.resolve_session($1) LIMIT 1) s, ${keys}`,
      [digest, [...new Set(permissions)]],
    );
    if (!row) return undefined;
    return {
      session: row,
      snapshots: permissions.map((permission) =>
        snapshotOf(tx, row.user_id, row, permission, declarations, registry),
      ),
    };
  }
}

function snapshotOf(
  tx: ProductTransaction,
  userId: UserId,
  facts: FactsRow,
  permission: string,
  declarations: ValidatedDeclarations,
  registry: UserAuthoritySnapshot['registry'],
): UserAuthoritySnapshot {
  return {
    revision: tx.revision,
    declarations,
    registry,
    user: facts.user ?? undefined,
    roles: facts.roles,
    permissions: facts.permissions
      .filter((p) => p.key === permission)
      .map((p) => ({ ...p, policy: { key: p.policy_key, version: p.policy_version } })),
    rules: facts.rules
      .filter((r) => r.permission === permission)
      .map((r) => ({
        id: r.id,
        permission: r.permission,
        subject: r.user_id
          ? { kind: 'identity', identity: r.user_id }
          : { kind: 'role', role: r.role ?? '' },
        effect: r.effect,
        template: { key: r.template, version: r.version },
        parameters: r.parameters,
      })),
    boundaries: facts.boundaries
      .filter((b) => b.permission === permission)
      .map((b) => ({
        identity: userId,
        permission: b.permission,
        boundary: { key: b.key, version: b.version },
        lifecycle: b.lifecycle,
      })),
  };
}

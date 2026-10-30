import type { Scalar, UserAuthoritySnapshot, UserId } from '../core/authorization.types.js';
import type { ValidatedDeclarations } from '../core/authorization.declarations.js';
import type { ProductTransaction } from '../../database/product-transaction.runner.js';

type Lifecycle = 'active' | 'deprecated' | 'retired';

export class ProductAuthorityFactsRepository {
  /**
   * Facts of one user for one permission, read in one statement after the fence. The planner only
   * consults the catalog row, rules and boundary bindings of the requested permission, so rows of
   * other permissions are not loaded; user and all roles are (roles feed record exceptions).
   */
  async read(
    tx: ProductTransaction,
    userId: UserId,
    permission: string,
    declarations: ValidatedDeclarations,
    registry: UserAuthoritySnapshot['registry'],
  ): Promise<UserAuthoritySnapshot> {
    return (await this.readWithClock(tx, userId, permission, declarations, registry, null))
      .snapshot;
  }

  /**
   * `read` plus the DB clock of the same statement: `now` and a `deadline` of
   * 2 s from it, never past `expiresAt` (the session's expiry; null when the caller keeps the
   * session statement's window). Lets `permitsMany` renew the window per pair without a round trip.
   */
  async readWithClock(
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
}

import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { Scalar } from '../../../authorization/core/authorization.types.js';
import {
  MAX_ROLE_GRANTS,
  type RoleGrantSpec,
} from '../../../authorization/helpers/role-grant.helper.js';

/** One stored rule of a role, exactly as the database holds it. */
export interface StoredRoleRule {
  readonly ruleId: string;
  readonly effect: 'allow' | 'deny';
  readonly permission: string;
  readonly template: string;
  readonly version: number;
  readonly parameters: Readonly<Record<string, Scalar>>;
}

const utf8 = (value: string) => Buffer.from(value, 'utf8');

/**
 * Statements of the role commands. Every method takes the transaction manager of the command and
 * runs inside its `admin` transaction; nothing here decides who may write.
 */
export class RoleWriteRepository {
  async runtimeRoleCount(manager: EntityManager): Promise<number> {
    const [row] = await manager.query<{ n: number }[]>(
      "SELECT count(*)::int AS n FROM role_definition WHERE managed_by = 'runtime'",
    );
    return row?.n ?? 0;
  }

  /** `false` when the key is taken (the primary key decides, under the anchor lock). */
  async insertRole(manager: EntityManager, key: string, label: string): Promise<boolean> {
    const rows = await manager.query<unknown[]>(
      `INSERT INTO role_definition(role_key, managed_by, label) VALUES ($1, 'runtime', $2)
       ON CONFLICT (role_key) DO NOTHING RETURNING 1`,
      [utf8(key), label],
    );
    return rows.length === 1;
  }

  /** Locks the runtime role; `undefined` for an absent role and for one the release owns. */
  async lockRole(manager: EntityManager, key: string): Promise<{ label: string } | undefined> {
    const [row] = await manager.query<{ label: string }[]>(
      "SELECT label FROM role_definition WHERE role_key = $1 AND managed_by = 'runtime' FOR UPDATE",
      [utf8(key)],
    );
    return row;
  }

  /** At most 300 rules; `truncated` means the role holds more and is not a role this API wrote. */
  async rules(
    manager: EntityManager,
    key: string,
  ): Promise<{ rules: StoredRoleRule[]; truncated: boolean }> {
    const rows = await manager.query<
      {
        rule_id: string;
        effect: 'allow' | 'deny';
        permission: string;
        template: string;
        version: number;
        parameters: Record<string, Scalar>;
      }[]
    >(
      `SELECT rule_id, effect, convert_from(permission_key,'UTF8') AS permission,
              convert_from(template_key,'UTF8') AS template, template_version AS version, parameters
         FROM policy_rule WHERE role_key = $1 ORDER BY 3, 4, 5 LIMIT ${MAX_ROLE_GRANTS + 1}`,
      [utf8(key)],
    );
    return {
      rules: rows.slice(0, MAX_ROLE_GRANTS).map((row) => ({
        ruleId: row.rule_id,
        effect: row.effect,
        permission: row.permission,
        template: row.template,
        version: row.version,
        parameters: row.parameters,
      })),
      truncated: rows.length > MAX_ROLE_GRANTS,
    };
  }

  async insertRules(
    manager: EntityManager,
    key: string,
    grants: readonly RoleGrantSpec[],
  ): Promise<void> {
    if (grants.length === 0) return;
    await manager.query(
      `INSERT INTO policy_rule(rule_id, permission_key, user_id, role_key, effect, template_key,
                               template_version, parameters, managed_by)
       SELECT g.id, convert_to(g.permission,'UTF8'), NULL, $1, 'allow', convert_to(g.template,'UTF8'),
              g.version, '{}'::jsonb, 'runtime'
         FROM unnest($2::uuid[], $3::text[], $4::text[], $5::int[]) AS g(id, permission, template, version)`,
      [
        utf8(key),
        grants.map(() => randomUUID()),
        grants.map((grant) => grant.permission),
        grants.map((grant) => grant.template.key),
        grants.map((grant) => grant.template.version),
      ],
    );
  }

  async deleteRules(manager: EntityManager, ruleIds: readonly string[]): Promise<void> {
    if (ruleIds.length === 0) return;
    await manager.query('DELETE FROM policy_rule WHERE rule_id = ANY(CAST($1 AS uuid[]))', [
      ruleIds,
    ]);
  }

  async setLabel(manager: EntityManager, key: string, label: string): Promise<void> {
    await manager.query('UPDATE role_definition SET label = $2 WHERE role_key = $1', [
      utf8(key),
      label,
    ]);
  }

  /** Any account in any state holds the role, or a record exception still names it. */
  async references(
    manager: EntityManager,
    key: string,
  ): Promise<{ held: boolean; exception: boolean }> {
    const [row] = await manager.query<{ held: boolean; exception: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM user_role WHERE role_key = $1) AS held,
              EXISTS (SELECT 1 FROM record_exception WHERE role_key = $1) AS exception`,
      [utf8(key)],
    );
    return { held: row?.held === true, exception: row?.exception === true };
  }

  async deleteRole(manager: EntityManager, key: string): Promise<void> {
    await manager.query('DELETE FROM policy_rule WHERE role_key = $1', [utf8(key)]);
    await manager.query('DELETE FROM role_definition WHERE role_key = $1', [utf8(key)]);
  }
}

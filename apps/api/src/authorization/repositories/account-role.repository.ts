import type { EntityManager } from 'typeorm';
import type { Scalar } from '../core/authorization.types.js';
import { MAX_ROLE_GRANTS } from '../helpers/role-grant.helper.js';
import type { GrantRuleFact } from '../helpers/grant-set.helper.js';

/** Most roles one account may hold (ADR-13). */
export const MAX_ACCOUNT_ROLES = 20;

const utf8 = (value: string) => Buffer.from(value, 'utf8');

/**
 * Statements of `account.assignRole` / `account.revokeRole`. Every method takes the manager of the
 * command and runs inside its `admin` transaction, after the exclusive fence; nothing here decides
 * who may do what.
 */
export class AccountRoleRepository {
  /** Serializes the commands on one account with the other writers of its row (suspend, reactivate). */
  async lockAccount(manager: EntityManager, userId: string): Promise<void> {
    await manager.query('SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE', [userId]);
  }

  async roleExists(manager: EntityManager, roleKey: string): Promise<boolean> {
    const rows = await manager.query<unknown[]>('SELECT 1 FROM role_definition WHERE role_key=$1', [
      utf8(roleKey),
    ]);
    return rows.length === 1;
  }

  /**
   * The rules of a role, as grant facts; `undefined` for an absent role. At most
   * `MAX_ROLE_GRANTS` rules are read: `truncated` means the role holds more and its inclusion in a
   * set cannot be proven.
   */
  async roleRules(
    manager: EntityManager,
    roleKey: string,
  ): Promise<{ facts: GrantRuleFact[]; truncated: boolean } | undefined> {
    const rows = await manager.query<
      {
        effect: 'allow' | 'deny' | null;
        permission: string | null;
        template: string | null;
        version: number | null;
        parameters: Record<string, Scalar> | null;
      }[]
    >(
      `SELECT pr.effect, convert_from(pr.permission_key,'UTF8') AS permission,
              convert_from(pr.template_key,'UTF8') AS template, pr.template_version AS version, pr.parameters
         FROM role_definition rd LEFT JOIN policy_rule pr ON pr.role_key = rd.role_key
        WHERE rd.role_key = $1 LIMIT ${MAX_ROLE_GRANTS + 1}`,
      [utf8(roleKey)],
    );
    if (rows.length === 0) return undefined;
    const facts: GrantRuleFact[] = [];
    for (const row of rows.slice(0, MAX_ROLE_GRANTS))
      if (row.permission !== null)
        facts.push({
          source: 'role',
          effect: row.effect ?? 'allow',
          permission: row.permission,
          template: { key: row.template ?? '', version: row.version ?? 0 },
          parameters: row.parameters ?? {},
        });
    return { facts, truncated: rows.length > MAX_ROLE_GRANTS };
  }

  /** How many roles the account holds and whether `roleKey` is one of them, in one statement. */
  async holding(
    manager: EntityManager,
    userId: string,
    roleKey: string,
  ): Promise<{ count: number; held: boolean }> {
    const [row] = await manager.query<{ count: number; held: boolean }[]>(
      `SELECT count(*)::int AS count, COALESCE(bool_or(role_key = $2), false) AS held
         FROM user_role WHERE user_id = $1`,
      [userId, utf8(roleKey)],
    );
    return { count: row?.count ?? 0, held: row?.held === true };
  }

  /** `false` when the pair exists already (the primary key decides). */
  async insert(manager: EntityManager, userId: string, roleKey: string): Promise<boolean> {
    const rows = await manager.query<unknown[]>(
      'INSERT INTO user_role(user_id, role_key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1',
      [userId, utf8(roleKey)],
    );
    return rows.length === 1;
  }

  /** `false` when the pair is gone already. */
  async delete(manager: EntityManager, userId: string, roleKey: string): Promise<boolean> {
    // A data-modifying CTE: the driver returns a bare DELETE as `[rows, count]`, not as rows.
    const [row] = await manager.query<{ gone: number }[]>(
      `WITH gone AS (DELETE FROM user_role WHERE user_id = $1 AND role_key = $2 RETURNING 1)
       SELECT count(*)::int AS gone FROM gone`,
      [userId, utf8(roleKey)],
    );
    return row?.gone === 1;
  }
}

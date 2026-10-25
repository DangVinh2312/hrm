import type { EntityManager } from 'typeorm';
import type { Scalar } from '../core/authorization.types.js';
import type { GrantRuleFact } from '../helpers/grant-set.helper.js';

/**
 * Rules that apply to accounts, for the grant-set comparison of ADR 0041 §2: the `policy_rule`
 * rows of every role an account holds, plus rules attached straight to the account. One
 * statement for any number of accounts (the command asks for the actor and the target), so there
 * is no per-role or per-rule query. It reads no cache: the caller holds the exclusive application
 * fence of an `admin` transaction, so no authority fact can change under the comparison.
 */
export class GrantFactsRepository {
  /**
   * The facts of each account in `userIds`; an account with none maps to `[]`. Reads at most
   * `maxRows` rule rows in total: `truncated` tells the caller the answer is incomplete. A
   * decision (ADR 0041 §2 (d)) must treat that as unprovable and refuse, never as a smaller set.
   * shortcut: one total cap, not per account; 20000 is far above 2 x (300 grants x 100 roles).
   */
  async read(
    manager: EntityManager,
    userIds: readonly string[],
    maxRows = 20_000,
  ): Promise<{ facts: Map<string, GrantRuleFact[]>; truncated: boolean }> {
    const rows = await manager.query<
      {
        holder: string;
        source: 'role' | 'user';
        effect: 'allow' | 'deny';
        permission: string;
        template: string;
        version: number;
        parameters: Record<string, Scalar>;
      }[]
    >(
      `SELECT holder, source, effect, permission, template, version, parameters FROM (SELECT ur.user_id AS holder, 'role' AS source, pr.effect AS effect,
              convert_from(pr.permission_key,'UTF8') AS permission,
              convert_from(pr.template_key,'UTF8') AS template,
              pr.template_version AS version, pr.parameters AS parameters
         FROM user_role ur JOIN policy_rule pr ON pr.role_key = ur.role_key
        WHERE ur.user_id = ANY(CAST($1 AS uuid[]))
       UNION ALL
       SELECT pr.user_id AS holder, 'user' AS source, pr.effect AS effect,
              convert_from(pr.permission_key,'UTF8') AS permission,
              convert_from(pr.template_key,'UTF8') AS template,
              pr.template_version AS version, pr.parameters AS parameters
         FROM policy_rule pr
        WHERE pr.user_id = ANY(CAST($1 AS uuid[]))) facts LIMIT CAST($2 AS int)`,
      [userIds, maxRows + 1],
    );
    const facts = new Map<string, GrantRuleFact[]>(userIds.map((id) => [id, []]));
    const truncated = rows.length > maxRows;
    for (const row of rows.slice(0, maxRows))
      facts.get(row.holder)?.push({
        source: row.source,
        effect: row.effect,
        permission: row.permission,
        template: { key: row.template, version: row.version },
        parameters: row.parameters,
      });
    return { facts, truncated };
  }
}

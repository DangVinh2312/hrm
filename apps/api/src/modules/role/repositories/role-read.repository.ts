import type {
  ProductQuery,
  ProductQueryContext,
} from '../../../authorization/services/product-authority.service.js';
import { canonicalJson } from '../../../authorization/core/policy.validator.js';
import type { GrantFactsRepository } from '../../../authorization/repositories/grant-facts.repository.js';
import {
  AccountAction,
  AccountResource,
} from '../../../administration/account-authorization.types.js';
import { scopedParameters } from '../../permission/permission-database.helper.js';
import { RoleAction, RoleResource } from '../role-authorization.types.js';
import type {
  AccountPermissionView,
  RoleGrantView,
  RoleMatrixView,
  RoleView,
} from '../role.types.js';

// shortcut: far above the ADR 0041 §3 limits (100 runtime roles, 300 grants per role) and the
// code roles of a release; a larger catalog is cut, never an unbounded response. Revisit with the
// write path, which enforces the limits.
const MAX_ROLES = 200;
const MAX_GRANTS_PER_ROLE = 500;
const MAX_ACCOUNT_ROLES = 200;
// shortcut: the account detail cuts at this many rules (the web schema accepts the same); a cut is
// not reported yet (ADR 0046 phase 2 item), so the page may show fewer rules than the account has.
const MAX_ACCOUNT_GRANTS = 5000;

/**
 * Reads of the role matrix (ADR 0041 §3, ADR 0046). Both queries run in the caller's read
 * transaction behind the plan of their action: a caller without the grant reaches nothing and the
 * answer is `undefined` (HTTP 404), the same as for a page that does not exist. The roles of the
 * release and the ones created later live in the same two tables (`managed_by` tells them apart);
 * the release rows are verified against the release at boot, so one statement serves both.
 */
export class RoleReadRepository {
  constructor(private readonly grants: GrantFactsRepository) {}

  /** Whether the plan of the action reaches the role anchor (the caller holds the grant). */
  async #reaches({ tx, scope }: ProductQueryContext): Promise<boolean> {
    const [row] = await tx.manager.query<{ ok: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM role_anchor r WHERE ${scope.sql}) AS ok`,
      [...scope.parameters],
    );
    return row?.ok === true;
  }

  /** role.read: one statement, roles with their rules and holder counts. */
  readonly list: ProductQuery<undefined, RoleMatrixView | undefined> = {
    resource: RoleResource.Role,
    action: RoleAction.Read,
    run: async (context) => {
      if (!(await this.#reaches(context))) return undefined;
      const roles = await context.tx.manager.query<RoleView[]>(
        `SELECT convert_from(d.role_key,'UTF8') AS key, d.label AS label, d.managed_by AS source,
                (SELECT count(*)::int FROM user_role u WHERE u.role_key = d.role_key) AS holders,
                COALESCE((SELECT json_agg(json_build_object(
                            'permission', g.permission, 'effect', g.effect, 'template', g.template,
                            'version', g.version, 'parameters', g.parameters)
                          ORDER BY g.permission, g.template, g.version)
                   FROM (SELECT convert_from(p.permission_key,'UTF8') AS permission, p.effect AS effect,
                                convert_from(p.template_key,'UTF8') AS template,
                                p.template_version AS version, p.parameters AS parameters
                           FROM policy_rule p WHERE p.role_key = d.role_key
                          ORDER BY 1, 3, 4 LIMIT ${MAX_GRANTS_PER_ROLE}) g), '[]'::json) AS grants
           FROM role_definition d ORDER BY d.managed_by, d.role_key LIMIT ${MAX_ROLES}`,
      );
      return { roles };
    },
  };

  /**
   * account.readPermissions: the roles and rules of one IAM account. The target is looked up
   * through the IAM-only projection under the caller's own scope, so Root, an absent id and an
   * account the plan does not reach are all `undefined`.
   */
  readonly accountPermissions: ProductQuery<
    { readonly accountId: string },
    AccountPermissionView | undefined
  > = {
    resource: AccountResource.Account,
    action: AccountAction.ReadPermissions,
    target: (input) => input.accountId,
    run: async ({ tx, scope }, input) => {
      const bound = scopedParameters(scope, input.accountId);
      const [found] = await tx.manager.query<{ ok: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM account_directory r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)) AS ok`,
        bound.parameters,
      );
      if (found?.ok !== true) return undefined;
      const roles = await tx.manager.query<AccountPermissionView['roles'][number][]>(
        `SELECT convert_from(d.role_key,'UTF8') AS key, d.label AS label, d.managed_by AS source
           FROM user_role u JOIN role_definition d ON d.role_key = u.role_key
          WHERE u.user_id = CAST($1 AS uuid) ORDER BY d.role_key LIMIT ${MAX_ACCOUNT_ROLES}`,
        [input.accountId],
      );
      const facts = (
        await this.grants.read(tx.manager, [input.accountId], MAX_ACCOUNT_GRANTS)
      ).facts.get(input.accountId);
      const seen = new Set<string>();
      const grants: (RoleGrantView & { source: 'role' | 'user' })[] = [];
      for (const fact of facts ?? []) {
        const grant = {
          permission: fact.permission,
          effect: fact.effect,
          template: fact.template.key,
          version: fact.template.version,
          parameters: fact.parameters,
          source: fact.source,
        };
        const key = canonicalJson(grant);
        if (seen.has(key)) continue;
        seen.add(key);
        grants.push(grant);
      }
      grants.sort(
        (a, b) => a.permission.localeCompare(b.permission) || a.template.localeCompare(b.template),
      );
      return { roles, grants };
    },
  };
}

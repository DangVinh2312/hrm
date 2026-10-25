import { canonicalJson } from '../core/policy.validator.js';
import type { Scalar } from '../core/authorization.types.js';

/**
 * Comparison of effective grant sets (ADR 0041 §2 (c)(d)). Pure and synchronous: the facts are
 * read elsewhere, in the fenced transaction of the command. A grant is the tuple
 * `(permission, template key, template version, parameters)`; two grants are the same only when
 * the whole tuple is equal. The helper does not try to decide whether one scope expression
 * contains another (docs/permission-boundaries.md): different tuples of one permission are
 * "incomparable" and refused, which is conservative on purpose.
 */

/** One `policy_rule` row that applies to an account, as read from the database. */
export interface GrantRuleFact {
  /** `role`: held through a role of the account; `user`: attached straight to the account. */
  readonly source: 'role' | 'user';
  readonly effect: 'allow' | 'deny';
  readonly permission: string;
  readonly template: { readonly key: string; readonly version: number };
  readonly parameters: Readonly<Record<string, Scalar>>;
}

/**
 * `within`: every grant of the target is in the actor set. `larger`: the target holds a
 * permission the actor does not. `incomparable`: same permission, different template/version/
 * parameters. `unprovable`: a deny or a rule on the user is present on either side.
 */
export type GrantVerdict = 'within' | 'larger' | 'incomparable' | 'unprovable';

const grantKey = (fact: GrantRuleFact): string =>
  canonicalJson([fact.permission, fact.template.key, fact.template.version, fact.parameters]);

/** A set can be proven only when every rule is an `allow` that comes through a role. */
const provable = (facts: readonly GrantRuleFact[]): boolean =>
  facts.every((fact) => fact.effect === 'allow' && fact.source === 'role');

export function compareGrantSets(
  target: readonly GrantRuleFact[],
  actor: readonly GrantRuleFact[],
): GrantVerdict {
  // Fail closed: a deny lowers what an account can do and a user rule has no UI path, so neither
  // side can be reduced to a plain set of grants.
  if (!provable(target) || !provable(actor)) return 'unprovable';
  const actorKeys = new Set(actor.map(grantKey));
  const actorPermissions = new Set(actor.map((fact) => fact.permission));
  let verdict: GrantVerdict = 'within';
  for (const fact of target) {
    if (actorKeys.has(grantKey(fact))) continue;
    if (!actorPermissions.has(fact.permission)) return 'larger';
    verdict = 'incomparable';
  }
  return verdict;
}

export const grantSetWithin = (verdict: GrantVerdict): boolean => verdict === 'within';

/**
 * `proceed` or `not_found` for a command on another account (ADR 0041 §2 (d)). Root is outside
 * IAM and has no grants, so it bypasses the comparison; an IAM actor gets `not_found` (the answer
 * for an absent account) for a target that is not within its own set.
 */
export function targetAccess(
  actor:
    { readonly kind: 'root' } | { readonly kind: 'iam'; readonly grants: readonly GrantRuleFact[] },
  target: readonly GrantRuleFact[],
): 'proceed' | 'not_found' {
  if (actor.kind === 'root') return 'proceed';
  return grantSetWithin(compareGrantSets(target, actor.grants)) ? 'proceed' : 'not_found';
}

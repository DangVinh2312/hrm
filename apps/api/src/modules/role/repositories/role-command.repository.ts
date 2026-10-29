import { ProductInvalidRequest } from '../../../authorization/product-data.gateway.js';
import type { ValidatedDeclarations } from '../../../authorization/core/authorization.declarations.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type ProductCommand,
  type ProductCommandContext,
} from '../../../authorization/services/product-authority.service.js';
import {
  MAX_RUNTIME_ROLES,
  type RoleGrantSpec,
  grantsAsFacts,
  grantsDigest,
  isRuntimeRoleKey,
  roleLabel,
} from '../../../authorization/helpers/role-grant.helper.js';
import {
  type GrantRuleFact,
  compareGrantSets,
  grantSetWithin,
} from '../../../authorization/helpers/grant-set.helper.js';
import { GrantFactsRepository } from '../../../authorization/repositories/grant-facts.repository.js';
import { ROLE_ID } from '../../permission/permission-database.helper.js';
import { RoleAction, RoleResource } from '../role-authorization.types.js';
import type { RoleCreateInput, RoleUpdateInput, RoleWriteResult } from '../role.types.js';
import { checkRoleCatalog } from '../role.validator.js';
import { type StoredRoleRule, RoleWriteRepository } from './role-write.repository.js';

/** The role is absent, not a runtime role, or outside what the IAM actor holds: HTTP 404. */
export class RoleNotFound extends Error {
  constructor() {
    super('Role not found');
  }
}

type RoleRemoved = { readonly status: 'deleted' };

const ruleKey = (rule: { permission: string; template: string; version: number }) =>
  `${rule.permission}\u0000${rule.template}\u0000${rule.version}`;

const grantKey = (grant: RoleGrantSpec) =>
  ruleKey({
    permission: grant.permission,
    template: grant.template.key,
    version: grant.template.version,
  });

const specOf = (rule: StoredRoleRule): RoleGrantSpec => ({
  permission: rule.permission,
  template: { key: rule.template, version: rule.version },
});

const factOf = (rule: StoredRoleRule): GrantRuleFact => ({
  source: 'role',
  effect: rule.effect,
  permission: rule.permission,
  template: { key: rule.template, version: rule.version },
  parameters: rule.parameters,
});

/**
 * The three role commands. Each runs in `admin` mode on the role anchor, which `execute` locks
 * FOR NO KEY UPDATE after the fence, the session and the plan, so every role write is serialized.
 * Then, in this order: the role row (update, delete), the actor's grant facts, the checks, the
 * writes and the audit event. A command does not trust its caller: it checks the catalog again.
 */
export class RoleCommandRepository {
  constructor(
    readonly declarations: ValidatedDeclarations,
    private readonly writes = new RoleWriteRepository(),
    private readonly facts = new GrantFactsRepository(),
  ) {}

  /** role.create */
  readonly create: ProductCommand<RoleCreateInput, RoleWriteResult> = {
    resource: RoleResource.Role,
    action: RoleAction.Create,
    mode: 'admin',
    target: () => ROLE_ID,
    run: (ctx, input) => this.#create(ctx, input),
  };

  /** role.update */
  readonly update: ProductCommand<RoleUpdateInput, RoleWriteResult> = {
    resource: RoleResource.Role,
    action: RoleAction.Update,
    mode: 'admin',
    target: () => ROLE_ID,
    run: (ctx, input) => this.#update(ctx, input),
  };

  /** role.delete */
  readonly remove: ProductCommand<{ readonly key: string }, RoleRemoved> = {
    resource: RoleResource.Role,
    action: RoleAction.Delete,
    mode: 'admin',
    target: () => ROLE_ID,
    run: (ctx, input) => this.#remove(ctx, input.key),
  };

  /** Root is outside the grant sets; an IAM actor must hold everything it writes or touches. */
  async #within(ctx: ProductCommandContext, target: readonly GrantRuleFact[]): Promise<boolean> {
    if (ctx.actor.kind === 'root') return true;
    const { facts, truncated } = await this.facts.read(ctx.tx.manager, [ctx.actor.id]);
    // An incomplete read cannot prove inclusion.
    if (truncated) return false;
    return grantSetWithin(compareGrantSets(target, facts.get(ctx.actor.id) ?? []));
  }

  #checked(label: string, grants: readonly RoleGrantSpec[]): void {
    if (roleLabel(label) !== label) throw new ProductInvalidRequest('Invalid label');
    checkRoleCatalog(this.declarations, grants);
  }

  /** The stored rules of a role the actor reaches; anything this API could not have written is refused. */
  async #current(ctx: ProductCommandContext, key: string, label: string) {
    const { rules, truncated } = await this.writes.rules(ctx.tx.manager, key);
    if (truncated) {
      if (ctx.actor.kind === 'iam') throw new RoleNotFound();
      throw new ProductCommandRejected('oversized_role');
    }
    if (!(await this.#within(ctx, rules.map(factOf)))) throw new RoleNotFound();
    return { rules, digest: grantsDigest(label, rules.map(specOf)) };
  }

  async #audit(
    ctx: ProductCommandContext,
    kind: 'permission.role-create' | 'permission.role-update' | 'permission.role-delete',
    roleKey: string,
    grantCount: number,
    digest: string,
  ): Promise<void> {
    await ctx.audit(
      kind,
      { resource: RoleResource.Role, key: ctx.target.key, objectId: ctx.target.objectId },
      { roleKey, grantCount, grantsDigest: digest },
    );
  }

  async #create(ctx: ProductCommandContext, input: RoleCreateInput): Promise<RoleWriteResult> {
    if (!isRuntimeRoleKey(input.key)) throw new ProductInvalidRequest('Invalid role key');
    this.#checked(input.label, input.grants);
    const { manager } = ctx.tx;
    if (!(await this.#within(ctx, grantsAsFacts(input.grants)))) throw new ProductAccessDenied();
    if ((await this.writes.runtimeRoleCount(manager)) >= MAX_RUNTIME_ROLES)
      throw new ProductCommandRejected('role_limit');
    if (!(await this.writes.insertRole(manager, input.key, input.label)))
      throw new ProductCommandRejected('role_exists');
    await this.writes.insertRules(manager, input.key, input.grants);
    const digest = grantsDigest(input.label, input.grants);
    await this.#audit(ctx, 'permission.role-create', input.key, input.grants.length, digest);
    return { key: input.key, digest };
  }

  async #update(ctx: ProductCommandContext, input: RoleUpdateInput): Promise<RoleWriteResult> {
    this.#checked(input.label, input.grants);
    const { manager } = ctx.tx;
    const role = await this.writes.lockRole(manager, input.key);
    if (!role) throw new RoleNotFound();
    const current = await this.#current(ctx, input.key, role.label);
    if (!(await this.#within(ctx, grantsAsFacts(input.grants)))) throw new ProductAccessDenied();
    // A deny or a parameterised rule is not something this API writes: it is not dropped silently.
    if (
      current.rules.some((rule) => rule.effect !== 'allow' || Object.keys(rule.parameters).length)
    )
      throw new ProductCommandRejected('unsupported_rule');
    if (current.digest !== input.expectedDigest) throw new ProductCommandRejected('stale_digest');
    const wanted = new Set(input.grants.map(grantKey));
    const kept = new Set(current.rules.map(ruleKey));
    await this.writes.deleteRules(
      manager,
      current.rules.filter((rule) => !wanted.has(ruleKey(rule))).map((rule) => rule.ruleId),
    );
    await this.writes.insertRules(
      manager,
      input.key,
      input.grants.filter((grant) => !kept.has(grantKey(grant))),
    );
    if (role.label !== input.label) await this.writes.setLabel(manager, input.key, input.label);
    const digest = grantsDigest(input.label, input.grants);
    await this.#audit(ctx, 'permission.role-update', input.key, input.grants.length, digest);
    return { key: input.key, digest };
  }

  async #remove(ctx: ProductCommandContext, key: string): Promise<RoleRemoved> {
    const { manager } = ctx.tx;
    const role = await this.writes.lockRole(manager, key);
    if (!role) throw new RoleNotFound();
    const current = await this.#current(ctx, key, role.label);
    const references = await this.writes.references(manager, key);
    if (references.held) throw new ProductCommandRejected('role_held');
    if (references.exception) throw new ProductCommandRejected('role_referenced');
    await this.writes.deleteRole(manager, key);
    await this.#audit(ctx, 'permission.role-delete', key, current.rules.length, current.digest);
    return { status: 'deleted' };
  }
}

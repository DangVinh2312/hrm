import type { Scalar } from '../core/authorization.types.js';
import type {
  ProductAuditEvent,
  ProductAuditRepository,
  ProductModuleAuditKind,
} from '../../audit/product-audit.repository.js';
import {
  isPermissionAuditKind,
  type ProductPermissionAuditDetail,
  type ProductPermissionAuditKind,
} from '../../audit/product-audit-detail.helper.js';
import { compilePlan, fieldPgTypes, keyPgTypes, quoteIdentifier } from '../product-sql.compiler.js';
import { type ProductAuthorityEngine, requestKey } from './product-authority-engine.service.js';
import {
  ProductAccessDenied,
  type ProductAuditTarget,
  type ProductCommand,
  type ProductResourceWrite,
} from './product-authority.types.js';

/** Writes of one fenced transaction: the allow-listed field update and the registered commands. */
export class ProductAuthorityWrites {
  constructor(
    private readonly engine: ProductAuthorityEngine,
    private readonly audit: ProductAuditRepository,
    private readonly writable: readonly ProductResourceWrite[],
    private readonly commands: ReadonlySet<ProductCommand<never, unknown>>,
  ) {}

  private get bindings() {
    return this.engine.bindings;
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
    const objectId = await this.engine.access(
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
              target: this.engine.requested(resource, key),
            }
          : {
              kind: 'data.update',
              actor: plan.userId,
              permission: plan.permission,
              principalKind: 'root',
              outcome: 'ok',
              target: { ...this.engine.requested(resource, key), objectId: updated },
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
    if (
      command.mode === 'admin' &&
      !(await this.engine.reachesTarget(secret, resource, action, key))
    )
      return undefined;
    const outcome = await this.engine.access(
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
            reaches: (otherResource, otherAction, otherKey) =>
              this.engine.reachesIn(tx, session, otherResource, otherAction, otherKey),
            audit: async (
              eventKind: ProductModuleAuditKind | ProductPermissionAuditKind,
              target: ProductAuditTarget,
              detail?: ProductPermissionAuditDetail,
            ) => {
              const declared = Object.hasOwn(this.bindings.declarations.resources, target.resource)
                ? this.bindings.declarations.resources[target.resource]
                : undefined;
              if (!declared) throw new TypeError(`Audit target ${target.resource} is undeclared`);
              const common = {
                actor: plan.userId,
                permission: plan.permission,
                target: {
                  resource: target.resource,
                  keyKind: declared.keyKind,
                  key: requestKey(this.bindings.core, declared.keyKind, target.key).value,
                  objectId: target.objectId,
                },
              };
              const event: ProductAuditEvent = isPermissionAuditKind(eventKind)
                ? { ...common, kind: eventKind, detail }
                : { ...common, kind: eventKind };
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
              target: this.engine.requested(resource, key),
            },
    );
    return outcome.found ? outcome.result : undefined;
  }
}

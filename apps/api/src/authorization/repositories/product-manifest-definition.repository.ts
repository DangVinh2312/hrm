import type { EntityManager } from 'typeorm';
import { canonicalJson } from '../core/policy.validator.js';
import { refKey } from '../core/authorization.declarations.js';
import type { ProductReleaseManifest } from '../services/product-manifest.service.js';
import { definitionHash, reject, utf8 } from '../helpers/product-manifest.helper.js';

/** Resource types, policies, templates, relation definitions and the permission catalog. */
export class ProductManifestDefinitionRepository {
  async apply(
    m: EntityManager,
    release: ProductReleaseManifest,
  ): Promise<{ created: Set<string> }> {
    const d = release.declarations;

    for (const resource of Object.values(d.resources)) {
      const rows = await m.query<{ key_kind: string }[]>(
        'SELECT key_kind FROM resource_type WHERE type_key = $1',
        [utf8(resource.key)],
      );
      if (rows.length === 0) {
        await m.query('INSERT INTO resource_type VALUES ($1, $2, $1)', [
          utf8(resource.key),
          resource.keyKind,
        ]);
      } else if (rows[0]!.key_kind !== resource.keyKind) {
        reject('immutable_definition', `resource ${resource.key} key kind`);
      }
    }

    // Policies before catalog bindings; published versions are immutable.
    for (const policy of Object.values(d.policies)) {
      const hash = definitionHash(policy);
      const rows = await m.query<{ hash: string; lifecycle: string }[]>(
        `SELECT encode(definition_hash, 'hex') AS hash, lifecycle FROM permission_policy
       WHERE policy_key = $1 AND policy_version = $2`,
        [utf8(policy.key), policy.version],
      );
      const lifecycle = policy.lifecycle ?? 'active';
      if (rows.length === 0) {
        await m.query('INSERT INTO permission_policy VALUES ($1, $2, decode($3, $4), $5, $6)', [
          utf8(policy.key),
          policy.version,
          hash,
          'hex',
          canonicalJson(policy),
          lifecycle,
        ]);
      } else if (rows[0]!.hash !== hash) {
        reject('immutable_definition', `policy ${refKey(policy)} changed without a new version`);
      } else if (rows[0]!.lifecycle !== lifecycle) {
        await m.query(
          'UPDATE permission_policy SET lifecycle = $3 WHERE policy_key = $1 AND policy_version = $2',
          [utf8(policy.key), policy.version, lifecycle],
        );
      }
    }

    for (const template of Object.values(d.templates)) {
      const hash = definitionHash(template);
      const rows = await m.query<{ hash: string }[]>(
        `SELECT encode(definition_hash, 'hex') AS hash FROM scope_template WHERE template_key = $1 AND version = $2`,
        [utf8(template.key), template.version],
      );
      if (rows.length === 0) {
        await m.query(`INSERT INTO scope_template VALUES ($1, $2, decode($3, 'hex'))`, [
          utf8(template.key),
          template.version,
          hash,
        ]);
      } else if (rows[0]!.hash !== hash) {
        reject(
          'immutable_definition',
          `template ${refKey(template)} changed without a new version`,
        );
      }
    }

    // Resource → resource relation definitions; identity targets are validated in code only.
    for (const relation of Object.values(d.relations)) {
      if (relation.target.kind !== 'resource') continue;
      const hash = definitionHash(relation);
      const rows = await m.query<{ hash: string }[]>(
        `SELECT encode(definition_hash, 'hex') AS hash FROM resource_relation_definition
       WHERE relation_key = $1 AND relation_version = $2`,
        [utf8(relation.key), relation.version],
      );
      if (rows.length === 0) {
        await m.query(
          `INSERT INTO resource_relation_definition VALUES ($1, $2, $3, $4, $5, $6, decode($7, 'hex'), 'active')`,
          [
            utf8(relation.key),
            relation.version,
            utf8(relation.sourceType),
            utf8(relation.target.type),
            relation.binding.kind,
            utf8(relation.binding.kind === 'domain' ? relation.binding.key : relation.key),
            hash,
          ],
        );
      } else if (rows[0]!.hash !== hash) {
        reject(
          'immutable_definition',
          `relation ${refKey(relation)} changed without a new version`,
        );
      }
    }

    // Catalog: new permissions, policy binding switches; permissions gone from code are deprecated.
    const created = new Set<string>();
    const declared: string[] = [];
    for (const resource of Object.values(d.resources)) {
      for (const [action, declaration] of Object.entries(resource.actions)) {
        const permission = `${resource.key}.${action}`;
        declared.push(permission);
        const rows = await m.query<
          {
            policy_key: string;
            policy_version: number;
            lifecycle: string;
            boundary: string | null;
          }[]
        >(
          `SELECT convert_from(policy_key, 'UTF8') AS policy_key, policy_version, lifecycle,
                boundary_requirement AS boundary
         FROM permission_catalog WHERE permission_key = $1`,
          [utf8(permission)],
        );
        if (rows.length === 0) {
          await m.query(
            `INSERT INTO permission_catalog VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
            [
              utf8(permission),
              utf8(resource.key),
              utf8(action),
              utf8(declaration.policy.key),
              declaration.policy.version,
              declaration.boundary,
            ],
          );
          created.add(permission);
        } else {
          const row = rows[0]!;
          // Also backfills the boundary requirement of rows that predate migration 003.
          if (
            row.policy_key !== declaration.policy.key ||
            row.policy_version !== declaration.policy.version ||
            row.lifecycle !== 'active' ||
            row.boundary !== declaration.boundary
          ) {
            await m.query(
              `UPDATE permission_catalog SET policy_key = $2, policy_version = $3, lifecycle = 'active',
               boundary_requirement = $4
             WHERE permission_key = $1`,
              [
                utf8(permission),
                utf8(declaration.policy.key),
                declaration.policy.version,
                declaration.boundary,
              ],
            );
          }
        }
      }
    }
    // A catalog row gone from code gets the fail-closed requirement.
    await m.query(
      `UPDATE permission_catalog SET lifecycle = 'deprecated',
       boundary_requirement = COALESCE(boundary_requirement, 'required')
     WHERE lifecycle = 'active' AND convert_from(permission_key, 'UTF8') <> ALL ($1::text[])`,
      [declared],
    );
    return { created };
  }
}

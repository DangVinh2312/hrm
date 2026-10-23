import type { EntityManager } from 'typeorm';
import { canonicalJson } from '../core/policy.validator.js';
import type { ProductReleaseManifest } from '../services/product-manifest.service.js';
import type { RelationSeed } from '../helpers/release-content.helper.js';
import { grantId, reject, utf8 } from '../helpers/product-manifest.helper.js';

/** Roles, default grants for permissions created now, and relation seeds. */
export class ProductManifestSeedRepository {
  async objectId(m: EntityManager, release: ProductReleaseManifest, end: RelationSeed['source']) {
    const kind = release.declarations.resources[end.type]!.keyKind;
    const rows = await m.query<{ id: string }[]>(
      `SELECT object_id::text AS id FROM object_ref WHERE type_key = $1 AND key_kind = $2 AND key_bytes = $3`,
      [utf8(end.type), kind, utf8(end.key.value)],
    );
    return rows[0]?.id;
  }

  async apply(
    m: EntityManager,
    release: ProductReleaseManifest,
    created: ReadonlySet<string>,
  ): Promise<void> {
    // No rank since 012: a role is its key, owner and label.
    for (const role of release.roles) {
      const rows = await m.query<{ managed_by: string; label: string }[]>(
        'SELECT managed_by, label FROM role_definition WHERE role_key = $1',
        [utf8(role.key)],
      );
      if (rows.length === 0) {
        await m.query(
          `INSERT INTO role_definition(role_key, managed_by, label) VALUES ($1, 'code', $2)`,
          [utf8(role.key), role.label],
        );
      } else if (rows[0]!.managed_by !== 'code') {
        reject('collision', `role ${role.key} is runtime-managed`);
      } else if (rows[0]!.label !== role.label) {
        await m.query('UPDATE role_definition SET label = $2 WHERE role_key = $1', [
          utf8(role.key),
          role.label,
        ]);
      }
    }

    // Defaults only for permissions created now. They stay code-owned (DB-protected) and leave only
    // through an explicit removeDefaultGrants entry of a later release.
    for (const grant of release.defaultGrants) {
      if (!created.has(grant.permission)) continue;
      await m.query(
        `INSERT INTO policy_rule (rule_id,permission_key,user_id,role_key,effect,template_key,template_version,parameters,managed_by) VALUES ($1, $2, NULL, $3, 'allow', $4, $5, $6, 'code') ON CONFLICT DO NOTHING`,
        [
          grantId(grant),
          utf8(grant.permission),
          utf8(grant.role),
          utf8(grant.template.key),
          grant.template.version,
          canonicalJson(grant.parameters),
        ],
      );
    }

    for (const seed of release.seeds) {
      const source = await this.objectId(m, release, seed.source);
      const target = await this.objectId(m, release, seed.target);
      if (!source || !target) reject('missing_reference', `seed ${seed.owner}/${seed.key}`);
      const occupant = await m.query<{ owner: string | null; key: string | null }[]>(
        `SELECT convert_from(seed_owner, 'UTF8') AS owner, convert_from(seed_key, 'UTF8') AS key FROM relation_edge
       WHERE relation_key = $1 AND relation_version = $2 AND source_object = $3 AND target_object = $4`,
        [utf8(seed.relation.key), seed.relation.version, source, target],
      );
      if (occupant[0] && (occupant[0].owner !== seed.owner || occupant[0].key !== seed.key)) {
        reject(
          'collision',
          `seed ${seed.owner}/${seed.key} collides with ${occupant[0].owner === null ? 'a runtime tuple' : 'another seed'}`,
        );
      }
      const values = [
        utf8(seed.relation.key),
        seed.relation.version,
        source,
        utf8(seed.source.type),
        target,
        utf8(seed.target.type),
        seed.startsAt,
        seed.expiresAt ?? null,
        utf8(seed.owner),
        utf8(seed.key),
      ];
      const own = await m.query<unknown[]>(
        'SELECT 1 FROM relation_edge WHERE seed_owner = $1 AND seed_key = $2',
        [utf8(seed.owner), utf8(seed.key)],
      );
      await m.query(
        own.length > 0
          ? `UPDATE relation_edge SET relation_key = $1, relation_version = $2, source_object = $3, source_type = $4,
             target_object = $5, target_type = $6, starts_at = $7, expires_at = $8
           WHERE seed_owner = $9 AND seed_key = $10`
          : `INSERT INTO relation_edge (relation_key, relation_version, source_object, source_type, target_object,
             target_type, starts_at, expires_at, seed_owner, seed_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        values,
      );
    }
    for (const removal of release.removeSeeds) {
      await m.query('DELETE FROM relation_edge WHERE seed_owner = $1 AND seed_key = $2', [
        utf8(removal.owner),
        utf8(removal.key),
      ]);
    }
  }
}

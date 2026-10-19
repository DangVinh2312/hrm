import type { EntityManager } from 'typeorm';
import { refKey } from '../core/authorization.declarations.js';
import type { ProductReleaseManifest } from '../services/product-manifest.service.js';
import { definitionHash, objectId, reject, utf8 } from './product-manifest.helper.js';

/** Same release already published: confirm every code-owned fact is still present (readiness). */
export async function verifyApplied(
  m: EntityManager,
  release: ProductReleaseManifest,
): Promise<void> {
  const d = release.declarations;
  const missing: string[] = [];
  for (const policy of Object.values(d.policies)) {
    const rows = await m.query<unknown[]>(
      `SELECT 1 FROM permission_policy WHERE policy_key = $1 AND policy_version = $2
       AND definition_hash = decode($3, 'hex')`,
      [utf8(policy.key), policy.version, definitionHash(policy)],
    );
    if (rows.length === 0) missing.push(`policy ${refKey(policy)}`);
  }
  for (const resource of Object.values(d.resources)) {
    for (const [action, declaration] of Object.entries(resource.actions)) {
      const rows = await m.query<unknown[]>(
        `SELECT 1 FROM permission_catalog WHERE permission_key = $1 AND policy_key = $2
         AND policy_version = $3 AND lifecycle = 'active' AND boundary_requirement = $4`,
        [
          utf8(`${resource.key}.${action}`),
          utf8(declaration.policy.key),
          declaration.policy.version,
          declaration.boundary,
        ],
      );
      if (rows.length === 0) missing.push(`permission ${resource.key}.${action}`);
    }
  }
  for (const boundary of Object.values(d.boundaries)) {
    const { lifecycle = 'active', ...definition } = boundary;
    const rows = await m.query<unknown[]>(
      `SELECT 1 FROM permission_boundary WHERE boundary_key = $1 AND boundary_version = $2
       AND definition_hash = decode($3, 'hex') AND lifecycle = $4`,
      [utf8(boundary.key), boundary.version, definitionHash(definition), lifecycle],
    );
    if (rows.length === 0) missing.push(`boundary ${refKey(boundary)}`);
  }
  for (const seed of release.boundaryBindings) {
    const rows = await m.query<unknown[]>(
      `SELECT 1 FROM user_boundary WHERE user_id = $1
       AND permission_key = $2 AND boundary_key = $3 AND boundary_version = $4 AND seed_owner = $5`,
      [
        seed.identity,
        utf8(seed.permission),
        utf8(seed.boundary.key),
        seed.boundary.version,
        utf8(seed.owner),
      ],
    );
    if (rows.length === 0) missing.push(`boundary binding ${seed.identity}/${seed.permission}`);
  }
  for (const role of release.roles) {
    const rows = await m.query<unknown[]>(
      `SELECT 1 FROM role_definition WHERE role_key = $1 AND managed_by = 'code'`,
      [utf8(role.key)],
    );
    if (rows.length === 0) missing.push(`role ${role.key}`);
  }
  for (const seed of release.seeds) {
    const source = await objectId(m, release, seed.source);
    const target = await objectId(m, release, seed.target);
    const rows = await m.query<unknown[]>(
      `SELECT 1 FROM relation_edge WHERE seed_owner = $1 AND seed_key = $2 AND relation_key = $3
       AND relation_version = $4 AND source_object = $5 AND target_object = $6 AND starts_at = $7
       AND expires_at IS NOT DISTINCT FROM $8::timestamptz`,
      [
        utf8(seed.owner),
        utf8(seed.key),
        utf8(seed.relation.key),
        seed.relation.version,
        source ?? null,
        target ?? null,
        seed.startsAt,
        seed.expiresAt ?? null,
      ],
    );
    if (rows.length === 0) missing.push(`seed ${seed.owner}/${seed.key}`);
  }
  if (missing.length > 0) reject('not_ready', missing.slice(0, 10).join(', '));
}

import { QueryFailedError, type EntityManager } from 'typeorm';
import { canonicalJson } from '../core/policy.validator.js';
import { refKey } from '../core/authorization.declarations.js';
import type { ProductReleaseManifest } from '../services/product-manifest.service.js';
import { definitionHash, reject, utf8 } from '../helpers/product-manifest.helper.js';

/** Boundary definitions, code-owned bindings, and the in-use guard. */
export class ProductManifestBoundaryRepository {
  async apply(m: EntityManager, release: ProductReleaseManifest): Promise<void> {
    const d = release.declarations;

    // Permission boundaries: immutable versions + entries, then code-owned bindings.
    for (const boundary of Object.values(d.boundaries)) {
      const { lifecycle = 'active', ...definition } = boundary;
      const hash = definitionHash(definition);
      const rows = await m.query<{ hash: string; lifecycle: string }[]>(
        `SELECT encode(definition_hash, 'hex') AS hash, lifecycle FROM permission_boundary
       WHERE boundary_key = $1 AND boundary_version = $2`,
        [utf8(boundary.key), boundary.version],
      );
      if (rows.length === 0) {
        await m.query(
          `INSERT INTO permission_boundary VALUES ($1, $2, decode($3, 'hex'), $4, $5)`,
          [utf8(boundary.key), boundary.version, hash, canonicalJson(definition), lifecycle],
        );
        for (const entry of boundary.entries) {
          await m.query(`INSERT INTO permission_boundary_entry VALUES ($1, $2, $3, $4)`, [
            utf8(boundary.key),
            boundary.version,
            utf8(entry.permission),
            canonicalJson(entry),
          ]);
        }
      } else if (rows[0]!.hash !== hash) {
        reject(
          'immutable_definition',
          `boundary ${refKey(boundary)} changed without a new version`,
        );
      } else if (rows[0]!.lifecycle !== lifecycle) {
        await m.query(
          `UPDATE permission_boundary SET lifecycle = $3
         WHERE boundary_key = $1 AND boundary_version = $2`,
          [utf8(boundary.key), boundary.version, lifecycle],
        );
      }
    }
    for (const seed of release.boundaryBindings) {
      const at = [seed.identity, utf8(seed.permission)];
      const [occupant] = await m.query<{ owner: string | null; key: string; version: number }[]>(
        `SELECT convert_from(seed_owner, 'UTF8') AS owner, convert_from(boundary_key, 'UTF8') AS key,
              boundary_version AS version
       FROM user_boundary WHERE user_id = $1 AND permission_key = $2`,
        at,
      );
      if (occupant && occupant.owner !== seed.owner) {
        reject(
          'collision',
          `boundary binding ${seed.identity}/${seed.permission} is ${occupant.owner === null ? 'runtime-managed' : 'owned by another seed'}`,
        );
      }
      if (occupant?.key === seed.boundary.key && occupant.version === seed.boundary.version)
        continue;
      try {
        await m.query(
          occupant
            ? `UPDATE user_boundary SET boundary_key = $3, boundary_version = $4
             WHERE user_id = $1 AND permission_key = $2`
            : `INSERT INTO user_boundary VALUES ($1, $2, $3, $4, $5)`,
          [
            ...at,
            utf8(seed.boundary.key),
            seed.boundary.version,
            ...(occupant ? [] : [utf8(seed.owner)]),
          ],
        );
      } catch (error) {
        const code =
          error instanceof QueryFailedError
            ? (error.driverError as { code?: unknown } | undefined)?.code
            : undefined;
        if (code === '23503')
          reject('missing_reference', `boundary binding ${seed.identity}/${seed.permission}`);
        throw error;
      }
    }
    for (const removal of release.removeBoundaryBindings) {
      await m.query(
        `DELETE FROM user_boundary
       WHERE user_id = $1 AND permission_key = $2 AND seed_owner = $3`,
        [removal.identity, utf8(removal.permission), utf8(removal.owner)],
      );
    }
    // A definition someone is still bound to is never retired or dropped: the code must keep it
    // until a binding command moves the members (bindings never follow a new version implicitly).
    const bound = await m.query<{ key: string; version: number }[]>(
      `SELECT convert_from(d.boundary_key, 'UTF8') AS key, d.boundary_version AS version
     FROM permission_boundary d
     WHERE EXISTS (
       SELECT 1 FROM user_boundary b WHERE b.boundary_key = d.boundary_key AND b.boundary_version = d.boundary_version)`,
      [],
    );
    const unusable = bound.filter((ref) => {
      const declaredBoundary = Object.hasOwn(d.boundaries, refKey(ref))
        ? d.boundaries[refKey(ref)]
        : undefined;
      return !declaredBoundary || declaredBoundary.lifecycle === 'retired';
    });
    if (unusable.length > 0)
      reject('definition_in_use', unusable.map((ref) => refKey(ref)).join(', '));
  }
}

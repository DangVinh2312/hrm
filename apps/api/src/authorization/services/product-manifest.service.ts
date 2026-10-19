import type { AuthorizationCore } from '../core/authorization.factory.js';
import { canonicalJson } from '../core/policy.validator.js';
import type { IdentityId } from '../core/authorization.types.js';
import type { EntityManager } from 'typeorm';
import {
  releaseContentHash,
  validateReleaseContent,
  validateRoleKeys,
  type DefaultGrant,
  type ReleaseContentSource,
  type ValidatedReleaseContent,
  type SyncResult,
} from '../helpers/release-content.helper.js';
import { ProductTransactionRunner } from '../../database/product-transaction.runner.js';
import { appendProductAudit } from '../../audit/product-audit.repository.js';
import { applyBoundaries } from '../helpers/product-manifest-boundaries.helper.js';
import { applyDefinitions } from '../helpers/product-manifest-definitions.helper.js';
import { applySeeds } from '../helpers/product-manifest-seeds.helper.js';
import { verifyApplied } from '../helpers/product-manifest-verify.helper.js';
import { grantId, reject, sha256 } from '../helpers/product-manifest.helper.js';
import { codeOwnedCatalogIsEmpty, protectedStateHash } from '../helpers/protected-state.helper.js';

const RUNTIME_CAPABILITY = 1;
export interface ProductRole {
  readonly key: string;
  readonly label: string;
}

export interface ProductReleaseSource extends ReleaseContentSource {
  readonly roles: readonly ProductRole[];
  /** Exact earlier default grants to delete; default grants stay code-owned until removed here. */
  readonly removeDefaultGrants?: readonly DefaultGrant[];
}

export interface ProductReleaseManifest extends ValidatedReleaseContent {
  readonly roles: readonly ProductRole[];
  readonly removeDefaultGrants: readonly DefaultGrant[];
  readonly hash: string;
}

/** Release → the authorization core that prepared it (provenance; never part of the hash). */
const productVerified = new WeakMap<object, AuthorizationCore>();

/** The core a release was prepared with, for the offline Root commands in `product-root.service.ts`. */
export const verifiedProductCore = (release: object): AuthorizationCore | undefined =>
  productVerified.get(release);

export function prepareProductRelease(
  source: ProductReleaseSource,
  core: AuthorizationCore,
): ProductReleaseManifest {
  if ((source.removeDefaultGrants?.length ?? 0) > 1000)
    reject('invalid_release', 'default grant removal limit');
  // `system.` is reserved: Root lives outside IAM (ADR 0012), no role may look like a system role.
  if (source.roles.some((role) => role.key.startsWith('system.')))
    reject('invalid_release', 'role key prefix system. is reserved');
  const roleKeys = validateRoleKeys(source.roles);
  const base = validateReleaseContent(source, core, roleKeys);
  // Same exact permission/template/parameter validation as the grants being removed.
  const removeDefaultGrants = validateReleaseContent(
    { ...source, defaultGrants: source.removeDefaultGrants ?? [] },
    core,
    roleKeys,
  ).defaultGrants;
  const removedIds = new Set(removeDefaultGrants.map(grantId));
  if (
    removedIds.size !== removeDefaultGrants.length ||
    base.defaultGrants.some((g) => removedIds.has(grantId(g)))
  )
    reject('invalid_release', 'default grant removal');
  const roles = source.roles.map((role) => ({ key: role.key, label: role.label }));
  const hash = sha256(
    canonicalJson({
      base: releaseContentHash(base, roles),
      // Omitted when empty so a release without removals keeps its hash.
      ...(removeDefaultGrants.length ? { removeDefaultGrants: [...removedIds].sort() } : {}),
    }),
  );
  const release: ProductReleaseManifest = Object.freeze({
    ...base,
    roles,
    hash,
    removeDefaultGrants: Object.freeze(removeDefaultGrants),
  });
  freezeRelease(release);
  productVerified.set(release, core);
  return release;
}

function freezeRelease(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeRelease(nested);
    Object.freeze(value);
  }
}

export class ProductManifestReconciler {
  constructor(
    private readonly runner: ProductTransactionRunner,
    private readonly options: {
      /** The runtime's core; a release prepared by another core is refused. */
      core: AuthorizationCore;
      actor: IdentityId;
      capabilities: { validators: readonly string[]; obligationHandlers: readonly string[] };
    },
  ) {
    if (!options.core.isCanonicalUuid(options.actor)) throw new TypeError('Invalid manifest actor');
  }

  async reconcile(release: ProductReleaseManifest): Promise<SyncResult> {
    if (productVerified.get(release) !== this.options.core)
      reject('invalid_release', 'product release was not prepared with this core');
    const available = new Set([
      ...this.options.capabilities.validators,
      ...this.options.capabilities.obligationHandlers,
    ]);
    if (
      [
        ...release.declarations.capabilities.validators,
        ...release.declarations.capabilities.obligationHandlers,
      ].some((c) => !available.has(c))
    )
      reject('missing_capability', 'missing registered implementation');
    return this.runner.run('sync', async (tx) => {
      const m = tx.manager;
      const [current] = await m.query<
        { sequence: string; hash: string; materialized: string | null }[]
      >(
        `SELECT release_sequence::text sequence,encode(manifest_hash,'hex') hash,encode(materialized_hash,'hex') materialized FROM authz_state WHERE singleton`,
      );
      if (!current) reject('not_ready', 'missing application state');
      if (BigInt(release.sequence) === BigInt(current!.sequence)) {
        if (release.hash !== current!.hash)
          reject('conflicting_release', 'same sequence with different content');
        await verifyApplied(m, release);
        if ((await protectedStateHash(m)) !== current!.materialized)
          reject('not_ready', 'code-owned facts drifted');
        return { changed: false, revision: tx.revision, manifestHash: release.hash };
      }
      if (BigInt(release.sequence) < BigInt(current!.sequence))
        reject('downgrade', 'older release');
      // Genesis (ADR 0012): a fresh database (sequence 0, empty code-owned catalog) accepts any
      // release as its first. Every other case keeps the strict predecessor.
      const genesis = current!.sequence === '0' && (await codeOwnedCatalogIsEmpty(m));
      if (!genesis && release.predecessor !== current!.sequence)
        reject('predecessor_mismatch', 'unexpected previous release');
      if (current!.sequence !== '0' && (await protectedStateHash(m)) !== current!.materialized)
        reject(
          'not_ready',
          'code-owned drift requires explicit offline repair before another release',
        );
      await apply(m, release);
      for (const grant of release.removeDefaultGrants) {
        const removed = await m.query<unknown[]>(
          "WITH removed AS (DELETE FROM policy_rule WHERE rule_id=$1 AND managed_by='code' AND system_owner IS NULL RETURNING 1) SELECT * FROM removed",
          [grantId(grant)],
        );
        if (!removed.length) reject('missing_reference', 'removed default grant is missing');
      }
      const materialized = await protectedStateHash(m);
      await m.query(
        `UPDATE authz_state SET revision=revision+1,manifest_hash=decode($1,'hex'),release_sequence=$2,min_runtime_capability=$3,materialized_hash=decode($4,'hex') WHERE singleton`,
        [release.hash, release.sequence, RUNTIME_CAPABILITY, materialized],
      );
      const revision = String(BigInt(tx.revision) + 1n);
      await appendProductAudit(tx, {
        kind: 'manifest.sync',
        actor: this.options.actor,
        sequence: release.sequence,
        hash: release.hash,
        publishedRevision: revision,
      });
      return { changed: true, revision, manifestHash: release.hash };
    });
  }
}

async function apply(m: EntityManager, release: ProductReleaseManifest): Promise<void> {
  const { created } = await applyDefinitions(m, release);
  await applyBoundaries(m, release);
  await applySeeds(m, release, created);
}

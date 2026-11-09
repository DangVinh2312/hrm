import { ProtectedStateRepository } from '../authorization/repositories/protected-state.repository.js';
import { reject } from '../authorization/helpers/product-manifest.helper.js';
import type { ProductTransactionRunner } from '../database/product-transaction.runner.js';

export async function verifyUpstreamManifest(
  runner: ProductTransactionRunner,
  expected: unknown,
): Promise<void> {
  if (
    typeof expected !== 'object' ||
    expected === null ||
    Object.keys(expected).length !== 2 ||
    Object.keys(expected).some((key) => key !== 'sequence' && key !== 'manifestHash') ||
    !('sequence' in expected) ||
    typeof expected.sequence !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(expected.sequence) ||
    BigInt(expected.sequence) > 9223372036854775807n ||
    !('manifestHash' in expected) ||
    typeof expected.manifestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expected.manifestHash)
  )
    return reject('not_ready', 'invalid Go manifest contract');

  const { sequence, manifestHash } = expected;
  await runner.run('sync', async (tx) => {
    const [current] = await tx.manager.query<
      { sequence: string; hash: string | null; materialized: string | null }[]
    >(
      `SELECT release_sequence::text sequence,encode(manifest_hash,'hex') hash,encode(materialized_hash,'hex') materialized FROM authz_state WHERE singleton`,
    );
    if (
      !current ||
      current.sequence !== sequence ||
      current.hash !== manifestHash ||
      !current.materialized ||
      (await new ProtectedStateRepository().hash(tx.manager)) !== current.materialized
    )
      reject('not_ready', 'Go manifest is not ready');
  });
}

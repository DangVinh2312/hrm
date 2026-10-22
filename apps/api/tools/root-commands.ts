import { open, unlink } from 'node:fs/promises';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import { resetProductMfa } from '../dist/auth/services/product-mfa.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  bootstrapProductRoot,
  reissueRootActivation,
} from '../dist/authorization/services/product-root.service.js';
import {
  revokeProductRoot,
  setRootEmail,
} from '../dist/authorization/services/product-root-lifecycle.service.js';
import { createProductRelease } from '../dist/authorization/product.manifest.js';
import type { Cli } from './cli.ts';

/** Reserves the delivery artifact before any state changes; never overwrites an old secret. */
async function withActivationFile<T>(
  path: string | undefined,
  work: (write: (secret: string) => Promise<void>) => Promise<{ committed: boolean; value: T }>,
): Promise<T> {
  if (!path) throw new Error('--activation-file outside the repository/logs is required');
  const file = await open(path, 'wx', 0o600);
  let committed = false;
  try {
    const result = await work((secret) => file.writeFile(secret + '\n'));
    committed = result.committed;
    return result.value;
  } finally {
    await file.close();
    if (!committed) await unlink(path).catch(() => undefined);
  }
}

/** ADR 0027 §3: one command creates the Root from an email; the id is generated in the command. */
export async function bootstrapRoot({ flags, core, audit, source }: Cli): Promise<void> {
  const operationId = flags['--operation'];
  if (!core.isCanonicalUuid(operationId))
    throw new Error('Explicit canonical --operation required');
  if (!flags['--issuer'] || !flags['--email']) throw new Error('--issuer and --email required');
  await withActivationFile(flags['--activation-file'], async (write) => {
    const runner = new ProductTransactionRunner({ bootstrap: await source('bootstrap') });
    const result = await bootstrapProductRoot(runner, audit, createProductRelease(core), {
      operationId,
      issuer: flags['--issuer']!,
      email: flags['--email']!,
    });
    if (result.activationSecret) await write(result.activationSecret);
    // The id is not a secret: `root:revoke` and `root:reset-mfa` take it as --user.
    console.log(
      result.initialized
        ? `Root enrollment committed (id ${result.userId}); activation still required.`
        : `Operation already committed (id ${result.userId}); marker and Root unchanged.`,
    );
    return { committed: result.initialized, value: undefined };
  });
}

/** Only the pending bootstrap Root without a binding: a new proof, the old ones void. */
export async function reissueRoot({ flags, audit, source }: Cli): Promise<void> {
  if (!flags['--issuer']) throw new Error('--issuer required');
  await withActivationFile(flags['--activation-file'], async (write) => {
    const runner = new ProductTransactionRunner({ bootstrap: await source('bootstrap') });
    const result = await reissueRootActivation(runner, audit, { issuer: flags['--issuer']! });
    await write(result.activationSecret);
    console.log('Root activation proof reissued; earlier proofs are void.');
    return { committed: true, value: undefined };
  });
}

export async function revokeRoot({ flags, core, audit, source }: Cli): Promise<void> {
  const userId = flags['--user'];
  const operationId = flags['--operation'];
  if (!core.isCanonicalUuid(userId) || !core.isCanonicalUuid(operationId))
    throw new Error('Explicit canonical --user and --operation required');
  if (!flags['--approval'] || !flags['--reason'])
    throw new Error('Root revocation requires --approval and --reason');
  const bootstrap = await source('bootstrap');
  const result = await revokeProductRoot(
    new ProductTransactionRunner({ bootstrap }),
    audit,
    {
      operationId,
      userId: userId as IdentityId,
      approval: flags['--approval'],
      reason: flags['--reason'],
    },
    core,
  );
  console.log(
    result.revoked
      ? 'Root suspended and its sessions revoked; marker unchanged.'
      : 'No unsuspended Root for this user; nothing changed.',
  );
}

/** ADR 0023 §4: only for a Root created before ADR 0027 (by subject, without an email). */
export async function setEmailOfRoot({ flags, core, audit, source }: Cli): Promise<void> {
  const userId = flags['--user'];
  const operationId = flags['--operation'];
  if (!core.isCanonicalUuid(userId) || !core.isCanonicalUuid(operationId))
    throw new Error('Explicit canonical --user and --operation required');
  if (!flags['--email']) throw new Error('--email required');
  const bootstrap = await source('bootstrap');
  const result = await setRootEmail(
    new ProductTransactionRunner({ bootstrap }),
    audit,
    { operationId, userId: userId as IdentityId, email: flags['--email'] },
    core,
  );
  console.log(
    result.changed
      ? 'Root email set, unverified until the next verified Google sign-in; its sessions ended.'
      : 'Root already has this email; nothing changed.',
  );
}

/** ADR 0026 §10: IAM accounts with the identity login, the Root with the bootstrap login. */
export async function resetMfa(cli: Cli, command: 'reset-mfa' | 'reset-root-mfa'): Promise<void> {
  const { flags, core, audit, source } = cli;
  const userId = flags['--user'];
  const operationId = flags['--operation'];
  if (!core.isCanonicalUuid(userId) || !core.isCanonicalUuid(operationId))
    throw new Error('Explicit canonical --user and --operation required');
  if (!flags['--approval'] || !flags['--reason'])
    throw new Error('Second factor reset requires --approval and --reason');
  const login = command === 'reset-root-mfa' ? 'bootstrap' : 'identity';
  const result = await resetProductMfa(
    new ProductTransactionRunner({ [login]: await source(login) }),
    audit,
    { operationId, userId, approval: flags['--approval'], reason: flags['--reason'] },
    core,
    login,
  );
  console.log(
    result.reset
      ? 'Second factor and recovery codes removed; the account sessions ended.'
      : 'No second factor; nothing changed.',
  );
}

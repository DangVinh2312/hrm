import { canonicalLoginEmail } from '../dist/authentication/services/product-identity.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { PRODUCT_OFFLINE_ACTOR } from '../dist/audit/product-audit.repository.js';
import type { Cli } from './cli.ts';

/**
 * An IAM account is enrolled by email only. `enroll --user --email --issuer`
 * waits 7 days for the first verified Google login of that email; no subject is ever pre-bound.
 */
export async function enrollAccount({ flags, core, audit, source }: Cli): Promise<void> {
  const userId = flags['--user'];
  if (!core.isCanonicalUuid(userId) || userId === PRODUCT_OFFLINE_ACTOR)
    throw new Error('--user must be an explicit canonical UUID, not the offline actor id');
  const issuer = flags['--issuer'];
  if (!issuer) throw new Error('Enrollment requires the exact --issuer');
  const email = canonicalLoginEmail(flags['--email'] || '');
  const runner = new ProductTransactionRunner({ identity: await source('identity') });
  await runner.run('revoke', async (tx) => {
    const enabled = await tx.manager.query<unknown[]>(
      'SELECT 1 FROM oidc_provider WHERE issuer=$1 AND enabled',
      [issuer],
    );
    if (!enabled.length) throw new Error('--issuer must be an enabled provider');
    await tx.manager.query(
      `INSERT INTO app_user(id,email_canonical,state) VALUES($1,$2,'pending')`,
      [userId, email],
    );
    await tx.manager.query(
      `INSERT INTO oidc_email_enrollment(user_id,issuer,email_canonical,expires_at,created_by) VALUES($1,$2,$3,statement_timestamp()+interval '7 days',$4)`,
      [userId, issuer, email, PRODUCT_OFFLINE_ACTOR],
    );
    await audit.appendProductAudit(tx, {
      kind: 'identity.enroll',
      actor: PRODUCT_OFFLINE_ACTOR,
      target: { userId },
      method: 'oidc',
    });
  });
  console.log('Pending account enrolled for its first verified Google login within 7 days.');
}

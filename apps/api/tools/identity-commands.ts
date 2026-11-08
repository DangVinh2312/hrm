import { canonicalLoginEmail } from '../dist/authentication/services/product-identity.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { PRODUCT_OFFLINE_ACTOR } from '../dist/audit/product-audit.repository.js';
import { isRoleKeyReference } from '../dist/authorization/helpers/role-grant.helper.js';
import type { Cli } from './cli.ts';

/**
 * An IAM account is enrolled by email only, with its first role.
 * `enroll --user --email --issuer --role` waits 7 days for the first verified Google login of that
 * email; no subject is ever pre-bound. Account and role commit together through the `authority`
 * login under the exclusive fence.
 */
export async function enrollAccount({ flags, core, audit, source }: Cli): Promise<void> {
  const userId = flags['--user'];
  if (!core.isCanonicalUuid(userId) || userId === PRODUCT_OFFLINE_ACTOR)
    throw new Error('--user must be an explicit canonical UUID, not the offline actor id');
  const issuer = flags['--issuer'];
  if (!issuer) throw new Error('Enrollment requires the exact --issuer');
  const roleKey = flags['--role'];
  if (!isRoleKeyReference(roleKey))
    throw new Error('Enrollment requires the --role of the account');
  const email = canonicalLoginEmail(flags['--email'] || '');
  const runner = new ProductTransactionRunner({ authority: await source('authority') });
  await runner.run('admin', async (tx) => {
    const role = await tx.manager.query<unknown[]>(
      'SELECT 1 FROM role_definition WHERE role_key=$1',
      [Buffer.from(roleKey, 'utf8')],
    );
    if (!role.length) throw new Error('--role must be an existing role');
    // The definer checks that the issuer is an enabled provider (22023 otherwise).
    await tx.manager.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
      userId,
      email,
      issuer,
      PRODUCT_OFFLINE_ACTOR,
    ]);
    await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
      userId,
      Buffer.from(roleKey, 'utf8'),
    ]);
    await audit.appendProductAudit(tx, {
      kind: 'identity.enroll',
      actor: PRODUCT_OFFLINE_ACTOR,
      target: { userId },
      method: 'oidc',
    });
    await audit.appendProductAudit(tx, {
      kind: 'permission.role-assign',
      actor: PRODUCT_OFFLINE_ACTOR,
      permission: 'account.assignRole',
      target: { resource: 'account', keyKind: 'uuid', key: userId, objectId: userId },
      detail: { roleKey, targetUserId: userId },
    });
  });
  console.log('Pending account enrolled for its first verified Google login within 7 days.');
}

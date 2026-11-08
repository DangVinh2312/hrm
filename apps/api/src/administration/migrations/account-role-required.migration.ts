import type { MigrationInterface, QueryRunner } from 'typeorm';
import { PRODUCT_OFFLINE_ACTOR } from '../../audit/product-audit.repository.js';

/**
 * An IAM account always holds a role. Provisioning moves to the `authority` login, which
 * also writes `user_role`, so the account and its first role commit together; `data` loses the
 * function. Every IAM account without a role gets `hr.employee`, one `permission.role-assign`
 * event each (metadata as the assign command writes it), under the `authz_state` row lock, and the
 * revision advances once. `hr.employee` comes from the manifest sync: a database holding such an
 * account before its first sync fails here on the foreign key, nothing is assigned.
 */
export class AccountRoleRequired1792108800006 implements MigrationInterface {
  name = 'AccountRoleRequired1792108800006';

  async up(runner: QueryRunner): Promise<void> {
    // Only the owner may change the function's ACL; the migration login is a NOINHERIT member.
    await runner.query(`
      SET LOCAL ROLE product_account_owner;
      GRANT EXECUTE ON FUNCTION public.provision_oidc_account(uuid,text,text,uuid) TO product_authority;
      REVOKE EXECUTE ON FUNCTION public.provision_oidc_account(uuid,text,text,uuid) FROM product_data;
      RESET ROLE;
    `);
    // Its own statement, so the next one reads accounts committed by anyone who held the fence.
    await runner.query('SELECT 1 FROM public.authz_state WHERE singleton FOR UPDATE');
    await runner.query(
      `WITH state AS (
         SELECT revision FROM public.authz_state WHERE singleton
       ), missing AS (
         SELECT u.id FROM public.app_user u
          WHERE u.kind = 'iam' AND NOT EXISTS (SELECT FROM public.user_role r WHERE r.user_id = u.id)
       ), assigned AS (
         INSERT INTO public.user_role(user_id, role_key)
         SELECT id, convert_to('hr.employee', 'UTF8') FROM missing RETURNING user_id
       ), audited AS (
         INSERT INTO public.audit_outbox(event_id, actor_id, event_kind, permission_key, object_id, policy_revision, occurred_at, safe_metadata)
         SELECT gen_random_uuid(), $1, convert_to('permission.role-assign', 'UTF8'), convert_to('account.assignRole', 'UTF8'),
                a.user_id, s.revision, statement_timestamp(),
                jsonb_build_object('targetUserId', a.user_id::text, 'resultingRevision', (s.revision + 1)::text,
                  'resource', 'account', 'keyKind', 'uuid', 'key', a.user_id::text, 'roleKey', 'hr.employee')
           FROM assigned a, state s
         RETURNING 1
       )
       UPDATE public.authz_state SET revision = revision + 1
        WHERE singleton AND EXISTS (SELECT FROM audited)`,
      [PRODUCT_OFFLINE_ACTOR],
    );
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Account role requirement requires an explicit restore; automatic downgrade is disabled',
      ),
    );
  }
}

-- +goose Up
-- +goose StatementBegin

      SET LOCAL ROLE product_account_owner;
      GRANT EXECUTE ON FUNCTION public.provision_oidc_account(uuid,text,text,uuid) TO product_authority;
      REVOKE EXECUTE ON FUNCTION public.provision_oidc_account(uuid,text,text,uuid) FROM product_data;
      RESET ROLE;
    
-- +goose StatementEnd

-- +goose StatementBegin
SELECT 1 FROM public.authz_state WHERE singleton FOR UPDATE
-- +goose StatementEnd

-- +goose StatementBegin
WITH state AS (
         SELECT revision FROM public.authz_state WHERE singleton
       ), missing AS (
         SELECT u.id FROM public.app_user u
          WHERE u.kind = 'iam' AND NOT EXISTS (SELECT FROM public.user_role r WHERE r.user_id = u.id)
       ), assigned AS (
         INSERT INTO public.user_role(user_id, role_key)
         SELECT id, convert_to('hr.employee', 'UTF8') FROM missing RETURNING user_id
       ), audited AS (
         INSERT INTO public.audit_outbox(event_id, actor_id, event_kind, permission_key, object_id, policy_revision, occurred_at, safe_metadata)
         SELECT gen_random_uuid(), '00000000-0000-4000-8000-000000000001'::uuid, convert_to('permission.role-assign', 'UTF8'), convert_to('account.assignRole', 'UTF8'),
                a.user_id, s.revision, statement_timestamp(),
                jsonb_build_object('targetUserId', a.user_id::text, 'resultingRevision', (s.revision + 1)::text,
                  'resource', 'account', 'keyKind', 'uuid', 'key', a.user_id::text, 'roleKey', 'hr.employee')
           FROM assigned a, state s
         RETURNING 1
       )
       UPDATE public.authz_state SET revision = revision + 1
        WHERE singleton AND EXISTS (SELECT FROM audited)
-- +goose StatementEnd

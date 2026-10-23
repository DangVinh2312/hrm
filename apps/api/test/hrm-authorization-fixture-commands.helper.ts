import { randomUUID } from 'node:crypto';
import {
  ProductCommandRejected,
  type ProductCommand,
} from '../dist/authorization/services/product-authority.service.js';
import { PermissionObjectRepository } from '../dist/modules/permission/permission-object.repository.js';

const permissionObject = new PermissionObjectRepository();

export type SubmitInput = { readonly employeeId: string; readonly teamId: string };

export type DecideInput = { readonly requestId: string; readonly expectedVersion: string };

export type Decided = { readonly state: string; readonly version: string };

/**
 * Fixture commands standing in for T5/T6 handlers: they exercise the capability (target lock,
 * object registration, typed audit, code-owned guards) without the business rules of later tasks.
 * Since migration 106 (T5) a request needs a `reason`; these fixtures write no segments.
 */
export const submit: ProductCommand<SubmitInput, { readonly id: string }> = {
  resource: 'employee',
  action: 'submitRequest',
  mode: 'write',
  target: (input) => input.employeeId,
  run: async (ctx, input) => {
    const id = randomUUID();
    const objectId = await permissionObject.register(ctx.tx, 'workRequest', id);
    await ctx.tx.manager.query(
      `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason) VALUES($1,$2,$3,$4,$5,'wfh','pending_lead','Lý do giả')`,
      [id, objectId, ctx.target.key, ctx.actor.id, input.teamId],
    );
    await ctx.audit('hr.request.submit', { resource: 'workRequest', key: id, objectId });
    return { id };
  },
};

export function transition(
  action: 'decideLead' | 'decideFinal' | 'cancel',
  from: string,
  to: string,
  stage: 'lead' | 'final' | 'cancel',
  decision: 'approve' | 'reject' | 'cancel',
  kind: 'hr.request.decide-lead' | 'hr.request.decide-final' | 'hr.request.cancel',
): ProductCommand<DecideInput, Decided> {
  return {
    resource: 'workRequest',
    action,
    mode: 'write',
    target: (input) => input.requestId,
    run: async (ctx, input) => {
      const [request] = await ctx.tx.manager.query<
        { owner: string; account: string | null; approver: boolean }[]
      >(
        `SELECT r.owner_account_id::text AS owner,e.account_id::text AS account,
           EXISTS(SELECT 1 FROM hr_request_lead l WHERE l.request_id=r.id AND l.lead_account_id=$2) AS approver
          FROM work_request r JOIN employee e ON e.id=r.employee_id WHERE r.id=$1`,
        [ctx.target.key, ctx.actor.id],
      );
      if (!request) throw new Error('Locked target vanished');
      const own = request.owner === ctx.actor.id || request.account === ctx.actor.id;
      // Guards of design §6.2 run for every principal, Root included.
      if (stage === 'cancel' ? !own : own) throw new ProductCommandRejected('self_decision');
      if (stage === 'lead' && !request.approver)
        throw new ProductCommandRejected('not_current_approver');
      const [updated] = await ctx.tx.manager.query<{ version: string }[]>(
        // TypeORM returns [rows, count] for a bare UPDATE; a CTE yields plain rows.
        `WITH updated AS(UPDATE work_request SET state=$2,version=version+1 WHERE id=$1 AND state=$3 AND version=CAST($4 AS int8) RETURNING version::text AS version) SELECT * FROM updated`,
        [ctx.target.key, to, from, input.expectedVersion],
      );
      if (!updated) throw new ProductCommandRejected('invalid_transition');
      await ctx.tx.manager.query(
        // Migration 107 (D08): a user reject carries its reason.
        `INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,actor_account_id,reason) VALUES($1,$2,$3,$4,'user',$5,$6)`,
        [
          randomUUID(),
          ctx.target.key,
          stage,
          decision,
          ctx.actor.id,
          decision === 'reject' ? 'Lý do giả' : null,
        ],
      );
      await ctx.audit(kind, {
        resource: 'workRequest',
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return { state: to, version: updated.version };
    },
  };
}

export const decideLead = transition(
  'decideLead',
  'pending_lead',
  'pending_final',
  'lead',
  'approve',
  'hr.request.decide-lead',
);

export const rejectFinal = transition(
  'decideFinal',
  'pending_final',
  'rejected',
  'final',
  'reject',
  'hr.request.decide-final',
);

export const cancel = transition(
  'cancel',
  'pending_lead',
  'cancelled',
  'cancel',
  'cancel',
  'hr.request.cancel',
);

export const forgetsAudit: ProductCommand<SubmitInput, string> = {
  ...submit,
  run: async (ctx, input) => {
    const id = randomUUID();
    const objectId = await permissionObject.register(ctx.tx, 'workRequest', id);
    await ctx.tx.manager.query(
      `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason) VALUES($1,$2,$3,$4,$5,'wfh','pending_lead','Lý do giả')`,
      [id, objectId, ctx.target.key, ctx.actor.id, input.teamId],
    );
    return id;
  },
};

export const commands = [submit, decideLead, rejectFinal, cancel, forgetsAudit];

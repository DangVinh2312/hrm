import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Release 9 scope view (ADR 0016 Release 9): a request rejected at the lead step whose owner is,
 * right now, the lead of a team. The COO reads exactly these in addition to the final queue and
 * what they decided: `workRequest.leadRejectedLeadOwned` has no identity column worth matching
 * (the target is the owner's account), so the template only asks that a row exists. Facts read at
 * statement time like every HR view; reading only, no decision follows from it.
 */
export const hrRequestViews: Readonly<Record<string, string>> = {
  hr_request_lead_rejected: `SELECT r.id AS request_id, r.owner_account_id FROM public.work_request r WHERE r.state = 'rejected' AND EXISTS (SELECT 1 FROM public.request_decision d WHERE d.request_id = r.id AND d.stage = 'lead' AND d.decision = 'reject' AND d.actor_kind = 'user') AND EXISTS (SELECT 1 FROM public.team_lead_assignment l WHERE l.lead_employee_id = r.employee_id AND l.starts_at <= statement_timestamp() AND (l.ends_at IS NULL OR l.ends_at > statement_timestamp()))`,
};

export class HrmRequestLeadRejected1792108800108 implements MigrationInterface {
  name = 'HrmRequestLeadRejected1792108800108';

  async up(r: QueryRunner): Promise<void> {
    for (const [name, definition] of Object.entries(hrRequestViews)) {
      await r.query(`CREATE VIEW ${name} WITH (security_invoker=true) AS ${definition}`);
      await r.query(`GRANT SELECT ON ${name} TO product_data`);
    }
  }

  down(): Promise<void> {
    return Promise.reject(new Error('Use reviewed forward migration'));
  }
}

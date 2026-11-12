package permission

const registerObjectBody = `
DECLARE
  v_object uuid := gen_random_uuid();
BEGIN
  IF p_type IS NULL OR p_key IS NULL OR p_type NOT IN ('employee','team','workRequest','employeeIdentity','leaveRate') THEN
    RAISE EXCEPTION 'object type is not registrable' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.object_ref(object_id,type_key,key_kind,key_bytes)
    VALUES (v_object, convert_to(p_type,'UTF8'), 'uuid', convert_to(p_key::text,'UTF8'));
  RETURN v_object;
END`

func scopeViewDefinitions() map[string]string {
	return map[string]string{
		"hr_employee_lead":         " SELECT m.employee_id,\n    e.account_id AS lead_account_id\n   FROM ((team_membership m\n     JOIN team_lead_assignment l ON ((l.team_id = m.team_id)))\n     JOIN employee e ON ((e.id = l.lead_employee_id)))\n  WHERE ((e.account_id IS NOT NULL) AND (m.starts_at <= statement_timestamp()) AND ((m.ends_at IS NULL) OR (m.ends_at > statement_timestamp())) AND (l.starts_at <= statement_timestamp()) AND ((l.ends_at IS NULL) OR (l.ends_at > statement_timestamp())));",
		"hr_request_decider":       " SELECT request_id,\n    actor_account_id\n   FROM request_decision d\n  WHERE (actor_kind = 'user'::text);",
		"hr_request_lead":          " SELECT r.id AS request_id,\n    e.account_id AS lead_account_id\n   FROM (((work_request r\n     JOIN team_membership m ON (((m.employee_id = r.employee_id) AND (m.starts_at <= statement_timestamp()) AND ((m.ends_at IS NULL) OR (m.ends_at > statement_timestamp())) AND ((m.team_id = r.team_id) OR (m.is_primary AND (NOT (EXISTS ( SELECT 1\n           FROM team_membership c\n          WHERE ((c.employee_id = r.employee_id) AND (c.team_id = r.team_id) AND (c.starts_at <= statement_timestamp()) AND ((c.ends_at IS NULL) OR (c.ends_at > statement_timestamp())))))))))))\n     JOIN team_lead_assignment l ON (((l.team_id = m.team_id) AND (l.starts_at <= statement_timestamp()) AND ((l.ends_at IS NULL) OR (l.ends_at > statement_timestamp())))))\n     JOIN employee e ON ((e.id = l.lead_employee_id)))\n  WHERE (e.account_id IS NOT NULL);",
		"hr_request_owner":         " SELECT r.id AS request_id,\n    e.account_id\n   FROM (work_request r\n     JOIN employee e ON ((e.id = r.employee_id)))\n  WHERE (e.account_id IS NOT NULL);",
		"hr_team_lead":             " SELECT l.team_id,\n    e.account_id AS lead_account_id\n   FROM (team_lead_assignment l\n     JOIN employee e ON ((e.id = l.lead_employee_id)))\n  WHERE ((e.account_id IS NOT NULL) AND (l.starts_at <= statement_timestamp()) AND ((l.ends_at IS NULL) OR (l.ends_at > statement_timestamp())));",
		"hr_employee_owner":        " SELECT id AS employee_id,\n    account_id\n   FROM employee e\n  WHERE (account_id IS NOT NULL);",
		"hr_leave_rate_owner":      " SELECT r.id AS rate_id,\n    e.account_id\n   FROM (leave_rate r\n     JOIN employee e ON ((e.id = r.employee_id)))\n  WHERE (e.account_id IS NOT NULL);",
		"hr_request_lead_rejected": " SELECT id AS request_id,\n    owner_account_id\n   FROM work_request r\n  WHERE ((state = 'rejected'::text) AND (EXISTS ( SELECT 1\n           FROM request_decision d\n          WHERE ((d.request_id = r.id) AND (d.stage = 'lead'::text) AND (d.decision = 'reject'::text) AND (d.actor_kind = 'user'::text)))) AND (EXISTS ( SELECT 1\n           FROM team_lead_assignment l\n          WHERE ((l.lead_employee_id = r.employee_id) AND (l.starts_at <= statement_timestamp()) AND ((l.ends_at IS NULL) OR (l.ends_at > statement_timestamp()))))));",
		"hr_team_member":           " SELECT m.team_id,\n    e.account_id\n   FROM (team_membership m\n     JOIN employee e ON ((e.id = m.employee_id)))\n  WHERE ((e.account_id IS NOT NULL) AND (m.starts_at <= statement_timestamp()) AND ((m.ends_at IS NULL) OR (m.ends_at > statement_timestamp())));",
	}
}

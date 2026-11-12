package app

import (
	"context"
	"hrm/api/internal/config"
	"hrm/api/internal/database"
)

func verifyDomainSchema(ctx context.Context, _ config.Config, pools database.Pools) error {
	for _, query := range []string{
		"SELECT id,title,owner_id,state,object_id FROM document LIMIT 0",
		"SELECT e.id,e.object_id,e.code,e.full_name,e.account_id,e.hired_on,e.terminated_on,e.job_position,e.classification,t.id,t.object_id,t.name,t.version,r.id,r.object_id,r.kind,r.state,r.version FROM employee e,team t,work_request r LIMIT 0",
		"SELECT i.employee_id,i.object_id,i.gender,i.phone,i.work_email,p.employee_id,p.status,l.id,l.object_id,l.annual_minutes,c.id,c.object_id FROM employee_identity i,employment_status_period p,leave_rate l,hr_company c LIMIT 0",
		"SELECT w.id,w.object_id,w.version,x.version,x.day,x.kind,x.name FROM work_calendar w,work_calendar_change x LIMIT 0",
		"SELECT r.reason,s.request_id,s.kind,s.work_date,s.start_minute,s.end_minute,s.minutes,i.actor_id,i.operation,i.key,i.payload_hash,i.target_id,i.result,d.reason FROM work_request r,work_request_segment s,hr_idempotency i,request_decision d LIMIT 0",
		"SELECT a.id,a.object_id,a.version,s.key,s.value,s.version,s.updated_at,s.updated_by,h.key,h.version,h.old_value,h.new_value,h.changed_by,h.changed_at FROM setting_anchor a,system_setting s,system_setting_history h LIMIT 0",
		"SELECT a.id,a.object_id FROM role_anchor a LIMIT 0",
	} {
		if _, err := pools[database.PurposeData].Exec(ctx, query); err != nil {
			return err
		}
	}
	return nil
}

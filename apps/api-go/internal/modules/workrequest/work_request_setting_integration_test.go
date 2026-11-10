//go:build integration

package workrequest

import (
	"errors"
	"strconv"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/modules/hrbase"
)

func TestChangedSettingsApplyToNewSubmitsAndFinalDecisions(t *testing.T) {
	f := newRequestFixture(t)
	if f.day(t, 0)[:7] != f.day(t, 4)[:7] {
		f.monday = f.day(t, 7)
	}
	set := func(key string, value int) {
		t.Helper()
		f.exec(t, `INSERT INTO system_setting(key,value,version,updated_by) VALUES($1,CAST($2 AS jsonb),1,$3)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=system_setting.version+1`, key, strconv.Itoa(value), f.accounts["H"])
	}
	set("hr.wfhMonthLimit", 2)
	for _, day := range []int{0, 1} {
		r := f.mustSubmit(t, "E", f.wfh(t, day))
		if r.WfhLimitExceeded == nil || *r.WfhLimitExceeded {
			t.Fatalf("within current WFH limit: %+v", r)
		}
		f.mustDecide(t, "C", f.mustDecide(t, "L", r, decisionApprove), decisionApprove)
	}
	r := f.mustSubmit(t, "E", f.wfh(t, 2))
	if r.WfhLimitExceeded == nil || !*r.WfhLimitExceeded {
		t.Fatalf("third day above the current limit: %+v", r)
	}
	waiting := f.mustDecide(t, "L", r, decisionApprove)
	input := f.verdict(t, waiting, decisionApprove)
	before := f.one(t, requestState)
	if _, _, err := f.decide(t, "C", input); !rejectedWith(err, "error.wfhLimitAckRequired") || f.one(t, requestState) != before {
		t.Fatalf("final decision ignored the current limit or wrote: %v", err)
	}
	set("hr.wfhMonthLimit", 3)
	if done, found, err := f.decide(t, "C", input); err != nil || !found || done.State != stateApproved {
		t.Fatalf("raised limit did not admit the same decision: %+v %v %v", done, found, err)
	}
	set("hr.wfhMonthLimit", 1)
	if f.one(t, `SELECT approved_count::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["E"]) != "3" || f.count(t, `SELECT count(*)::text FROM work_request WHERE employee_id=$1 AND state='approved'`, f.employees["E"]) != 3 {
		t.Fatal("lowering the limit changed approved days")
	}
	if next := f.mustSubmit(t, "E", f.wfh(t, 3)); next.WfhLimitExceeded == nil || !*next.WfhLimitExceeded {
		t.Fatalf("lowered limit did not affect the next submit: %+v", next)
	}
	set("hr.wfhMonthLimit", 0)
	if next := f.mustSubmit(t, "L", f.wfh(t, 4)); next.WfhLimitExceeded == nil || !*next.WfhLimitExceeded {
		t.Fatalf("zero limit: %+v", next)
	}
	set("hr.wfhMonthLimit", 4)
	if next := f.mustSubmit(t, "L", f.wfh(t, 0)); next.WfhLimitExceeded == nil || *next.WfhLimitExceeded {
		t.Fatalf("restored limit: %+v", next)
	}

	future := f.wfh(t, 7)
	ahead := f.count(t, `SELECT (CAST($1 AS date)-`+hrbase.BusinessToday+`)::text`, future.Dates[0])
	set("hr.requestWindowFutureDays", ahead-1)
	before = f.one(t, requestState)
	if _, err := f.submit(t, "E", future); !rejectedWith(err, "error.dateOutOfRange") || f.one(t, requestState) != before {
		t.Fatalf("future window refusal: %v", err)
	}
	set("hr.requestWindowFutureDays", ahead)
	r = f.mustSubmit(t, "E", future)
	set("hr.requestWindowFutureDays", 0)
	if done := f.mustDecide(t, "C", f.mustDecide(t, "L", r, decisionApprove), decisionApprove); done.State != stateApproved {
		t.Fatalf("narrower submit window changed an existing request: %+v", done)
	}
	set("hr.requestWindowFutureDays", 90)
	past := f.wfh(t, 0)
	past.Dates[0] = f.one(t, `SELECT to_char(`+hrbase.BusinessToday+`-CASE extract(isodow FROM `+hrbase.BusinessToday+`)::int WHEN 1 THEN 3 WHEN 7 THEN 2 ELSE 1 END,'YYYY-MM-DD')`)
	back := f.count(t, `SELECT (`+hrbase.BusinessToday+`-CAST($1 AS date))::text`, past.Dates[0])
	set("hr.requestWindowPastDays", back-1)
	before = f.one(t, requestState)
	if _, err := f.submit(t, "E", past); !rejectedWith(err, "error.dateOutOfRange") || f.one(t, requestState) != before {
		t.Fatalf("past window refusal: %v", err)
	}
	set("hr.requestWindowPastDays", back)
	f.mustSubmit(t, "E", past)
	set("hr.requestMaxDays", 3)
	before = f.one(t, requestState)
	if _, err := f.submit(t, "E", f.wfh(t, 14, 15, 16, 17)); !errors.Is(err, apperror.ErrInvalidRequest) || f.one(t, requestState) != before {
		t.Fatalf("maximum request days: %v", err)
	}
	f.mustSubmit(t, "E", f.wfh(t, 14, 15, 16))
	set("hr.requestMaxDays", 31)
	f.mustSubmit(t, "E", f.wfh(t, 17, 18, 21, 22))
}

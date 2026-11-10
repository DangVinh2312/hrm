//go:build integration

package workrequest

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/hrbase"
)

func TestRequestSegmentsDecisionsAndClaimsKeepTheirACLAndChecks(t *testing.T) {
	f := newRequestFixture(t)
	r := f.mustSubmit(t, "E", f.leave(t, hrbase.RequestUnpaidLeave, 0, 840, 1080))
	f.mustDecide(t, "L", r, decisionReject)
	assertCode := func(name, want string, err error) {
		t.Helper()
		if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != want {
			t.Errorf("%s: want SQLSTATE %s, got %T", name, want, err)
		}
	}
	for _, sql := range []string{
		`UPDATE work_request_segment SET end_minute=960 WHERE request_id=$1`,
		`DELETE FROM work_request_segment WHERE request_id=$1`,
		`UPDATE work_request SET reason='x' WHERE id=$1`,
		`UPDATE work_request SET kind='wfh' WHERE id=$1`,
		`DELETE FROM work_request WHERE id=$1`,
		`UPDATE request_decision SET reason='x' WHERE request_id=$1`,
		`DELETE FROM request_decision WHERE request_id=$1`,
		`DELETE FROM hr_idempotency WHERE target_id=$1`,
		`UPDATE hr_idempotency SET result='{}' WHERE target_id=$1`,
	} {
		_, err := database.Run(t.Context(), f.s.Runner, database.ModeWrite, func(_ context.Context, tx *database.Tx) (struct{}, error) {
			_, err := tx.Exec(sql, r.ID)
			return struct{}{}, err
		}, database.RunOptions{})
		assertCode(sql, "42501", err)
	}
	day := f.day(t, 1)
	_, err := database.Run(t.Context(), f.s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		_, err := tx.Exec(`INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes) VALUES($1,'unpaid-leave',CAST($2 AS date),540,660,120)`, r.ID, day)
		return struct{}{}, err
	}, database.RunOptions{})
	assertCode("authority cannot append a segment", "42501", err)
	for _, tc := range []struct {
		kind                string
		start, end, minutes int
		day                 int
		code                string
	}{
		{"unpaid-leave", 540, 660, 121, 1, "23514"},
		{"unpaid-leave", 540, 660, 0, 1, "23514"},
		{"unpaid-leave", 0, 1440, 721, 1, "23514"},
		{"unpaid-leave", 1380, 1445, 60, 1, "23514"},
		{"unpaid-leave", 660, 540, 120, 1, "23514"},
		{"wfh", 540, 1080, 480, 1, "23503"},
		{"unpaid-leave", 540, 660, 120, 0, "23505"},
	} {
		_, err := f.conn.Exec(t.Context(), `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes) VALUES($1,$2,CAST($3 AS date),$4,$5,$6)`, r.ID, tc.kind, f.day(t, tc.day), tc.start, tc.end, tc.minutes)
		assertCode("segment bounds/kind/date", tc.code, err)
	}
	_, err = f.conn.Exec(t.Context(), `UPDATE work_request SET reason='' WHERE id=$1`, r.ID)
	assertCode("empty request reason", "23514", err)
	_, err = f.conn.Exec(t.Context(), `INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result) VALUES($1,'workRequest.edit',gen_random_uuid(),repeat('a',64),$2,'{}')`, f.accounts["E"], r.ID)
	assertCode("unknown idempotency operation", "23514", err)
	other := f.mustSubmit(t, "E", f.wfh(t, 2))
	for _, reason := range []*string{nil, new("")} {
		_, err := f.conn.Exec(t.Context(), `INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,actor_account_id,reason) VALUES(gen_random_uuid(),$1,'lead','reject','user',$2,$3)`, other.ID, f.accounts["L"], reason)
		assertCode("user rejection requires reason", "23514", err)
	}
}

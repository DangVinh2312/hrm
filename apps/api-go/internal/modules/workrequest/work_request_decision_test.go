package workrequest

import (
	"encoding/json/v2"
	"errors"
	"reflect"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/hrbase"
)

var (
	states = []string{statePendingLead, statePendingFinal, stateApproved, stateRejected, stateCancelled}
	events = []requestEvent{eventLeadApprove, eventLeadReject, eventFinalApprove, eventFinalReject, eventCancel, eventCancelApproved}
)

func TestNextStateCoversEveryStateEventAndChain(t *testing.T) {
	allowed := map[approvalChain]map[string]string{
		chainLead: {
			"pending_lead/lead_approve": stateApproved, "pending_lead/lead_reject": stateRejected, "pending_lead/cancel": stateCancelled,
			"pending_final/final_approve": stateApproved, "pending_final/final_reject": stateRejected, "pending_final/cancel": stateCancelled,
			"approved/cancel_approved": stateCancelled,
		},
		chainLeadFinal: {
			"pending_lead/lead_approve": statePendingFinal, "pending_lead/lead_reject": stateRejected, "pending_lead/cancel": stateCancelled,
			"pending_final/final_approve": stateApproved, "pending_final/final_reject": stateRejected, "pending_final/cancel": stateCancelled,
			"approved/cancel_approved": stateCancelled,
		},
	}
	checked := 0
	for chain, table := range allowed {
		for _, state := range states {
			for _, event := range events {
				want, ok := table[state+"/"+string(event)]
				if got, valid := nextState(state, event, chain); got != want || valid != ok {
					t.Errorf("%s %s %s: %q %v", chain, state, event, got, valid)
				}
				checked++
			}
		}
	}
	if checked != 60 {
		t.Errorf("checked %d", checked)
	}
}

func TestTheChainIsLeadOnlyForLateAndEarly(t *testing.T) {
	for kind, chain := range map[hrbase.RequestKind]approvalChain{
		hrbase.RequestLateArrival: chainLead, hrbase.RequestEarlyDeparture: chainLead,
		hrbase.RequestWfh: chainLeadFinal, hrbase.RequestAnnualLeave: chainLeadFinal, hrbase.RequestUnpaidLeave: chainLeadFinal,
	} {
		if got := approvalChainOf(kind); got != chain {
			t.Errorf("%s: %s", kind, got)
		}
	}
}

// parseDecisionBody decodes raw as DecodeCommand does, then validates it with the path id and one good key.
func parseDecisionBody(raw, id string, keys []string) (DecisionInput, error) {
	var body decisionBody
	if err := json.Unmarshal([]byte(raw), &body, json.RejectUnknownMembers(true)); err != nil {
		return DecisionInput{}, apperror.ErrInvalidRequest
	}
	return parseDecision(id, keys, body)
}

func TestTheDecisionBodyIsApproveOrRejectWithAReasonToReject(t *testing.T) {
	reason := func(s string) *string { return &s }
	for raw, want := range map[string]DecisionInput{
		`{"expectedVersion":"1","decision":"approve"}`:                                    {ExpectedVersion: "1", Decision: decisionApprove},
		`{"expectedVersion":"1","decision":"approve","reason":null}`:                      {ExpectedVersion: "1", Decision: decisionApprove},
		`{"expectedVersion":"1","decision":"approve","reason":"Ok"}`:                      {ExpectedVersion: "1", Decision: decisionApprove, Reason: reason("Ok")},
		`{"expectedVersion":"1","decision":"approve","acknowledgeWfhLimit":true}`:         {ExpectedVersion: "1", Decision: decisionApprove, AcknowledgeWfhLimit: true},
		`{"expectedVersion":"1","decision":"approve","acknowledgeWfhLimit":false}`:        {ExpectedVersion: "1", Decision: decisionApprove},
		`{"expectedVersion":"2","decision":"reject","reason":" Tr` + text(0xf9) + `ng "}`: {ExpectedVersion: "2", Decision: decisionReject, Reason: reason("Tr" + text(0xf9) + "ng")},
	} {
		want.RequestID, want.IdempotencyKey = team, someKey
		if got, err := parseDecisionBody(raw, team, []string{someKey}); err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %+v, %v", raw, got, err)
		}
	}
	refused := []string{
		`{}`, `null`, `[]`, `{"decision":"approve"}`, `{"expectedVersion":"1"}`,
		`{"expectedVersion":"1","decision":"reject"}`, `{"expectedVersion":"1","decision":"reject","reason":null}`,
		`{"expectedVersion":"1","decision":"reject","reason":""}`, `{"expectedVersion":"1","decision":"reject","reason":"   "}`,
		`{"expectedVersion":"1","decision":"reject","reason":"a\nb"}`, `{"expectedVersion":"1","decision":"approve","reason":5}`,
		`{"expectedVersion":"1","decision":"approve","reason":"` + strings.Repeat("x", 1001) + `"}`,
		`{"expectedVersion":"1","decision":"approve","acknowledgeWfhLimit":null}`, `{"expectedVersion":"1","decision":"approve","acknowledgeWfhLimit":"true"}`,
		`{"expectedVersion":"1","decision":"approve","acknowledgeWfhLimit":1}`,
	}
	for _, decision := range []string{`"skip"`, `"cancel"`, `"APPROVE"`, `1`, `null`} {
		refused = append(refused, `{"expectedVersion":"1","decision":`+decision+`}`)
	}
	for _, version := range []string{`1`, `"0"`, `"01"`, `"-1"`, `""`, `null`} {
		refused = append(refused, `{"expectedVersion":`+version+`,"decision":"approve"}`)
	}
	for _, extra := range []string{"stage", "state", "actorId", "employeeId", "version", "kind"} {
		refused = append(refused, `{"expectedVersion":"1","decision":"approve","`+extra+`":"final"}`)
	}
	for _, raw := range refused {
		if got, err := parseDecisionBody(raw, team, []string{someKey}); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("accepted %s: %+v, %v", raw, got, err)
		}
	}
	good := `{"expectedVersion":"1","decision":"approve"}`
	if _, err := parseDecisionBody(good, "not-a-uuid", []string{someKey}); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("bad id: %v", err)
	}
	for _, keys := range [][]string{nil, {strings.ToUpper(someKey)}, {someKey, someKey}} {
		if _, err := parseDecisionBody(good, team, keys); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("keys %v: %v", keys, err)
		}
	}
}

// The hashes are what RequestApprovalService.decide of the TypeScript build (apps/api/dist) computed, so a
// key first claimed by NestJS still replays on Go. Only a set acknowledgement joins the payload.
func TestTheDecisionHashIsTheBytesOfTheTypeScriptBuild(t *testing.T) {
	reason := func(points ...rune) *string { s := string(points); return &s }
	for _, tc := range []struct {
		input DecisionInput
		hash  string
	}{
		{DecisionInput{ExpectedVersion: "1", Decision: decisionApprove}, "e84b1ac90020a7a6af43fa7481ef25df5a3eb882b7006f5404217a3dfe15deb3"},
		{DecisionInput{ExpectedVersion: "1", Decision: decisionApprove, AcknowledgeWfhLimit: true}, "848d03c391091dade33cccd02dcb9ebd62772bf077620eab209818b790d1487a"},
		{DecisionInput{ExpectedVersion: "2", Decision: decisionReject, Reason: reason('T', 'r', 0xf9, 'n', 'g', ' ', 'l', 0x1ecb, 'c', 'h')}, "5e83abceb2b11822fb9ef9e9e6baabcbc2f963a0439d4d80d8c42f5b3650bd44"},
		{DecisionInput{ExpectedVersion: "12", Decision: decisionApprove, AcknowledgeWfhLimit: true, Reason: reason(0x110, 0x1ed3, 'n', 'g', ' ', 0x1b0, 0x302, 0x300, ' ', 0x1f44d, 0x1f468, 0x200d, 0x1f469)}, "d299759f9722053e975702c60603bacd6c5af91edd265f971493344848b7120b"},
		{DecisionInput{ExpectedVersion: "3", Decision: decisionReject, Reason: reason('<', 'a', '>', '&', '"', 'b', '"', '\\', 'c', 0x2028, 'd', 0x2029, 'e', 0x85, 'f', 0xa0, 'g')}, "6fc11603c7b6fe8a527564d272ddccb0a5c1b7a766a0192d729dc34907bc1598"},
	} {
		tc.input.RequestID = team
		got, err := decisionHash(tc.input)
		if err != nil || got != tc.hash {
			t.Errorf("%+v: %s, %v", tc.input, got, err)
		}
		tc.input.IdempotencyKey = someKey
		if again, err := decisionHash(tc.input); err != nil || again != got {
			t.Errorf("the key changed the hash: %s, %v", again, err)
		}
	}
}

func TestAKindIsOpenOnlyWithEveryEffectItNeeds(t *testing.T) {
	all := createApprovedEffects()
	kinds := []hrbase.RequestKind{hrbase.RequestLateArrival, hrbase.RequestEarlyDeparture, hrbase.RequestWfh, hrbase.RequestAnnualLeave, hrbase.RequestUnpaidLeave}
	for _, kind := range kinds {
		if handlers, open := all.effectsOf(kind); !open || len(handlers) != len(requiredEffects[kind]) {
			t.Errorf("%s closed in production: %d", kind, len(handlers))
		}
	}
	noop := func(*database.Tx, string, bool) error { return nil }
	for registry, open := range map[string]map[hrbase.RequestKind]bool{
		"no leave":      {hrbase.RequestAnnualLeave: false, hrbase.RequestWfh: true, hrbase.RequestLateArrival: true, hrbase.RequestUnpaidLeave: true},
		"no wfh":        {hrbase.RequestWfh: false, hrbase.RequestAnnualLeave: true, hrbase.RequestEarlyDeparture: true},
		"no attendance": {hrbase.RequestLateArrival: false, hrbase.RequestEarlyDeparture: false, hrbase.RequestWfh: false, hrbase.RequestAnnualLeave: false, hrbase.RequestUnpaidLeave: false},
	} {
		effects := ApprovedEffects{Leave: noop, Wfh: noop, Attendance: noop}
		switch registry {
		case "no leave":
			effects.Leave = nil
		case "no wfh":
			effects.Wfh = nil
		case "no attendance":
			effects.Attendance = nil
		}
		for kind, want := range open {
			if handlers, got := effects.effectsOf(kind); got != want || (!got && handlers != nil) {
				t.Errorf("%s, %s: open %v", registry, kind, got)
			}
		}
	}
	if _, open := (ApprovedEffects{}).effectsOf("overtime"); open {
		t.Error("an unknown kind is open")
	}
}

package workrequest

import (
	"encoding/json/v2"
	"errors"
	"reflect"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
)

// parseCancelBody decodes raw as DecodeCommand does, then validates it with the path id and the keys.
func parseCancelBody(raw, id string, keys []string) (CancelInput, error) {
	var body cancelBody
	if err := json.Unmarshal([]byte(raw), &body, json.RejectUnknownMembers(true)); err != nil {
		return CancelInput{}, apperror.ErrInvalidRequest
	}
	return parseCancel(id, keys, body)
}

func TestTheCancelBodyIsAVersionAndAnOptionalReason(t *testing.T) {
	reason := func(s string) *string { return &s }
	for raw, want := range map[string]CancelInput{
		`{"expectedVersion":"1"}`:                                     {ExpectedVersion: "1"},
		`{"expectedVersion":"1","reason":null}`:                       {ExpectedVersion: "1"},
		`{"expectedVersion":"3","reason":" HR ` + text(0x111) + ` "}`: {ExpectedVersion: "3", Reason: reason("HR " + text(0x111))},
	} {
		want.RequestID, want.IdempotencyKey = team, someKey
		if got, err := parseCancelBody(raw, team, []string{someKey}); err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %+v, %v", raw, got, err)
		}
	}
	refused := []string{
		`{}`, `null`, `[]`, `{"reason":"x"}`, `{"expectedVersion":"1","reason":""}`, `{"expectedVersion":"1","reason":"   "}`,
		`{"expectedVersion":"1","reason":"a\nb"}`, `{"expectedVersion":"1","reason":5}`,
		`{"expectedVersion":"1","reason":"` + strings.Repeat("x", 1001) + `"}`,
	}
	for _, version := range []string{`1`, `"0"`, `"01"`, `"-1"`, `""`, `null`} {
		refused = append(refused, `{"expectedVersion":`+version+`}`)
	}
	for _, extra := range []string{"state", "stage", "decision", "actorId", "employeeId", "version"} {
		refused = append(refused, `{"expectedVersion":"1","`+extra+`":"cancelled"}`)
	}
	for _, raw := range refused {
		if got, err := parseCancelBody(raw, team, []string{someKey}); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("accepted %s: %+v, %v", raw, got, err)
		}
	}
	good := `{"expectedVersion":"1"}`
	if _, err := parseCancelBody(good, "not-a-uuid", []string{someKey}); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("bad id: %v", err)
	}
	for _, keys := range [][]string{nil, {strings.ToUpper(someKey)}, {someKey, someKey}} {
		if _, err := parseCancelBody(good, team, keys); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("keys %v: %v", keys, err)
		}
	}
}

// The hashes are what RequestCancelService.cancel of the TypeScript build (apps/api/dist) computed, so a key
// first claimed by NestJS still replays on Go.
func TestTheCancelHashIsTheBytesOfTheTypeScriptBuild(t *testing.T) {
	reason := func(points ...rune) *string { s := string(points); return &s }
	for _, tc := range []struct {
		input CancelInput
		hash  string
	}{
		{CancelInput{ExpectedVersion: "1"}, "7946630a0b41c4618bf9a81f5ef61ad7bd5c489dfe9763f9b5733b004312ed51"},
		{CancelInput{ExpectedVersion: "3", Reason: reason('H', 'R', ' ', 0x111, 0x1ea3, 'o')}, "a3b137752b5709f9da1b2a8c69156da088f3972e7fc82b0f44d843df1b7325c7"},
		{CancelInput{ExpectedVersion: "12", Reason: reason(0x110, 0x1ed3, 'n', 'g', ' ', 0x1b0, 0x302, 0x300, ' ', 0x1f44d, 0x1f468, 0x200d, 0x1f469)}, "b1952206ad31fde9f0ab9366b6d355514aba21a148d9b57457c125ba70be659a"},
		{CancelInput{ExpectedVersion: "2", Reason: reason('<', 'a', '>', '&', '"', 'b', '"', '\\', 'c', 0x2028, 'd', 0x2029, 'e', 0x85, 'f', 0xa0, 'g')}, "c8891faa2a5d4f2e50cf5af219ae5f510a056eded809132af5c2144670d012ab"},
	} {
		tc.input.RequestID = team
		got, err := cancelHash(tc.input)
		if err != nil || got != tc.hash {
			t.Errorf("%+v: %s, %v", tc.input, got, err)
		}
		tc.input.IdempotencyKey = someKey
		if again, err := cancelHash(tc.input); err != nil || again != got {
			t.Errorf("the key changed the hash: %s, %v", again, err)
		}
	}
}

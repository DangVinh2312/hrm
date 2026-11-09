package team

import (
	"encoding/json/v2"
	"errors"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/httpapi"
)

func TestUnboundOperationsFailClosed(t *testing.T) {
	operations := NewOperations()
	if len(operations.All()) != 8 {
		t.Fatal("operation inventory incomplete")
	}
	service := operations.Bind(nil)
	_, listErr := service.List(t.Context(), "", ListQuery{Limit: 20})
	_, detailErr := service.Detail(t.Context(), "", testID)
	_, createErr := service.Create(t.Context(), "", CreateInput{Name: "Team"})
	_, renameErr := service.Rename(t.Context(), "", RenameInput{TeamID: testID, Name: "Name", ExpectedVersion: "1"})
	_, addErr := service.AddMember(t.Context(), "", MemberInput{TeamID: testID, EmployeeID: testID})
	_, primaryErr := service.SetPrimary(t.Context(), "", MembershipRef{TeamID: testID, EmployeeID: testID})
	_, endErr := service.EndMembership(t.Context(), "", MembershipRef{TeamID: testID, EmployeeID: testID})
	_, leadErr := service.AssignLead(t.Context(), "", LeadInput{TeamID: testID})
	for _, err := range []error{listErr, detailErr, createErr, renameErr, addErr, primaryErr, endErr, leadErr} {
		if !errors.Is(err, apperror.ErrAccessDenied) {
			t.Fatalf("unbound operation: %v", err)
		}
	}
}
func TestGeneratedUUIDsAreDistinctValidKeys(t *testing.T) {
	first, second := newUUID(), newUUID()
	if first == second {
		t.Fatal("UUID repeated")
	}
	for _, id := range []string{first, second} {
		if _, err := httpapi.InputUUID(id); err != nil {
			t.Fatalf("invalid generated UUID: %v", err)
		}
	}
}

func TestTeamResponseJSONShape(t *testing.T) {
	person := Person{EmployeeID: testID, Code: "NV1", FullName: "Fixture"}
	instant := "2026-11-09T01:02:03.123456Z"
	view := View{ID: testID, Name: "Team", Version: "999999999999999999", Lead: &person,
		Members:     []MemberView{{Person: person, Primary: true, Since: instant}},
		LeadHistory: []LeadHistoryView{{Person: person, StartsAt: instant}}}
	body, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	expected := `{"id":"` + testID + `","name":"Team","version":"999999999999999999","lead":{"employeeId":"` + testID + `","code":"NV1","fullName":"Fixture"},"members":[{"employeeId":"` + testID + `","code":"NV1","fullName":"Fixture","primary":true,"since":"` + instant + `"}],"leadHistory":[{"employeeId":"` + testID + `","code":"NV1","fullName":"Fixture","startsAt":"` + instant + `","endsAt":null}]}`
	if string(body) != expected {
		t.Fatalf("team response: %s", body)
	}
}

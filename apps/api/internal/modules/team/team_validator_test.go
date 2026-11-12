package team

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"hrm/api/internal/apperror"
)

const testOrigin = "https://hrm.example.test"
const testID = "10000000-0000-4000-8000-000000000001"

func inputContext(body string) *gin.Context {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Request.Header.Set("Origin", testOrigin)
	token := strings.Repeat("a", 43)
	c.Request.Header.Set("X-Csrf-Token", token)
	c.Request.Header.Set("Cookie", "__Host-authz_csrf="+token)
	c.Params = gin.Params{{Key: "id", Value: testID}, {Key: "employeeId", Value: testID}}
	return c
}

func TestCreateValidation(t *testing.T) {
	for _, body := range []string{`{}`, `{"name":null}`, `{"name":" "}`, `{"name":"a\u0000b"}`, `{"name":"a\u007fb"}`, `{"name":"` + strings.Repeat("a", 201) + `"}`, `{"name":"ok","extra":1}`, `{"Name":"ok"}`, `{"name":"a","name":"b"}`, `{"name":42}`} {
		t.Run(body, func(t *testing.T) {
			_, err := parseCreate(inputContext(body), testOrigin)
			if !errors.Is(err, apperror.ErrInvalidRequest) {
				t.Fatalf("invalid create accepted: %v", err)
			}
		})
	}
	got, err := parseCreate(inputContext(`{"name":"\ufeff `+strings.Repeat("\U0001f600", 200)+` \ufeff"}`), testOrigin)
	if err != nil || got.Name != strings.Repeat("\U0001f600", 200) {
		t.Fatalf("trim/rune boundary: %v", err)
	}
	got, err = parseCreate(inputContext(`{"name":"\u0085ok\u0085"}`), testOrigin)
	if err != nil || got.Name != "\u0085ok\u0085" {
		t.Fatal("trim removed a character outside JS whitespace")
	}
}

func TestRenameValidation(t *testing.T) {
	for _, version := range []string{"", "0", "01", "-1", "1.0", "9223372036854775808", "1\n"} {
		c := inputContext(`{"expectedVersion":"` + strings.ReplaceAll(version, "\n", `\n`) + `","name":"ok"}`)
		if _, err := parseRename(c, testOrigin); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Fatalf("invalid version %q accepted", version)
		}
	}
	for _, id := range []string{"", "bad", testID + "\n"} {
		c := inputContext(`{"expectedVersion":"1","name":"ok"}`)
		c.Params[0].Value = id
		if _, err := parseRename(c, testOrigin); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Fatalf("invalid UUID %q accepted", id)
		}
	}
	got, err := parseRename(inputContext(`{"expectedVersion":"1","name":" ok "}`), testOrigin)
	if err != nil || got.TeamID != testID || got.Name != "ok" || got.ExpectedVersion != "1" {
		t.Fatalf("rename: %+v %v", got, err)
	}
}

func TestMemberAndLeadValidation(t *testing.T) {
	for _, body := range []string{`{}`, `{"employeeId":"` + testID + `"}`, `{"employeeId":"` + testID + `","primary":null}`, `{"employeeId":"bad","primary":false}`, `{"employeeId":"` + testID + `","primary":"false"}`, `{"employeeId":"` + testID + `","primary":false,"extra":1}`} {
		if _, err := parseMember(inputContext(body), testOrigin); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Fatalf("invalid member accepted: %s", body)
		}
	}
	got, err := parseMember(inputContext(`{"employeeId":"`+testID+`","primary":false}`), testOrigin)
	if err != nil || got.EmployeeID != testID || got.TeamID != testID || got.Primary {
		t.Fatalf("false primary: %+v %v", got, err)
	}
	for _, body := range []string{`{}`, `{"employeeId":"bad"}`, `{"employeeId":true}`, `{"employeeId":null,"extra":1}`} {
		if _, err := parseLead(inputContext(body), testOrigin); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Fatalf("invalid lead accepted: %s", body)
		}
	}
	lead, err := parseLead(inputContext(`{"employeeId":null}`), testOrigin)
	if err != nil || lead.TeamID != testID || lead.EmployeeID != nil {
		t.Fatalf("clear lead: %+v %v", lead, err)
	}
	lead, err = parseLead(inputContext(`{"employeeId":"`+testID+`"}`), testOrigin)
	if err != nil || lead.EmployeeID == nil || *lead.EmployeeID != testID {
		t.Fatalf("lead UUID: %+v %v", lead, err)
	}
	for _, ids := range [][2]string{{"bad", testID}, {testID, "bad"}} {
		if _, err := parseMembership(ids[0], ids[1]); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Fatal("invalid membership UUID accepted")
		}
	}
}

func TestAssignmentGuards(t *testing.T) {
	self := "actor"
	other := "other"
	for _, tc := range []struct {
		account *string
		working bool
		reject  bool
	}{{&self, true, true}, {&other, false, true}, {nil, false, true}, {nil, true, false}, {&other, true, false}} {
		err := checkAssignable(tc.account, tc.working, self)
		if errors.Is(err, apperror.ErrCommandRejected) != tc.reject {
			t.Fatalf("assignment guard: %+v %v", tc, err)
		}
	}
	if err := requireMember([]membership{{Team: "other"}}, "target"); err == nil {
		t.Fatal("nonmember lead accepted")
	}
	if err := requireMember([]membership{{Team: "target"}}, "target"); err != nil {
		t.Fatalf("member lead rejected: %v", err)
	}
}

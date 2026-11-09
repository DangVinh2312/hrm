//go:build integration

package app

import (
	"context"
	"encoding/json/v2"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/contract"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const (
	m1Absent       = "00000000-0000-4000-8000-000000000000"
	m1Admin        = "hr.admin"
	m1Employee     = "hr.employee"
	m1Attacker     = "http://attacker.example"
	m1ExpireAll    = `UPDATE application_session SET created_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 second' WHERE user_id=$1`
	m1Suspend      = `UPDATE app_user SET state='suspended' WHERE id=$1`
	m1BindBoundary = `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,convert_to('team.assign','UTF8'),convert_to('hrAdministration','UTF8'),1)`
	m1InsertRule   = `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to($2,'UTF8'),$1,$3,convert_to($4,'UTF8'),1,'{}','runtime')`
	m1Audits    = `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to($2,'UTF8')`
	m1SettingAt = `SELECT coalesce((SELECT version::text FROM system_setting WHERE key=$1),'0')`
	m1State     = `SELECT concat_ws('|',
      (SELECT revision::text FROM authz_state WHERE singleton),
      (SELECT count(*)||':'||coalesce(sum(version),0) FROM team),
      (SELECT count(*)||':'||count(*) FILTER (WHERE ends_at IS NULL)||':'||count(*) FILTER (WHERE is_primary AND ends_at IS NULL) FROM team_membership),
      (SELECT count(*)||':'||count(*) FILTER (WHERE ends_at IS NULL) FROM team_lead_assignment),
      (SELECT count(*)||':'||coalesce(sum(version),0) FROM system_setting),
      (SELECT count(*)::text FROM system_setting_history),
      (SELECT count(*)::text FROM audit_outbox))`
)

// m1Denials is one deny rule per permission of the M1 routes, each over the whole scope of its template.
var m1Denials = map[string]string{
	"setting.read": "setting", "setting.readProfile": "setting", "setting.updateRule": "setting", "setting.updateProfile": "setting",
	"team.read": "allTeams", "team.update": "allTeams", "team.assign": "allTeams", "hrCompany.createTeam": "company",
}

// m1Cell is the expected answer of one cell: the success status of the contract (ok), a status with its
// error body or an exact body, or the reason the cell does not apply (na).
type m1Cell struct {
	ok     bool
	status int
	body   string
	na     string
}

func m1Ok() m1Cell                { return m1Cell{ok: true} }
func m1Refused(status int) m1Cell { return m1Cell{status: status} }
func m1NA(reason string) m1Cell   { return m1Cell{na: reason} }

func (c m1Cell) empty() bool { return !c.ok && c.status == 0 && c.na == "" }

func (c m1Cell) answers(status int, body string) bool {
	if c.body != "" {
		return status == c.status && body == c.body
	}
	return status == c.status && body == `{"statusCode":`+strconv.Itoa(c.status)+`,"code":"`+m1Codes[c.status]+`"}`
}

var m1Codes = map[int]string{400: "error.invalidRequest", 401: "error.authenticationFailed", 403: "error.accessDenied", 404: "error.notFound", 409: "error.conflict"}

// m1Cells are the cells of ADR-20 section 4 for one route; every one is filled or says why it does not apply.
type m1Cells struct {
	signedOut, expired, suspended, noGrant, granted, boundary, deny, root, fresh m1Cell
	csrf, origin, foreign, absent, absentEmployee, invalid, extra, idempotency   m1Cell
}

func (c m1Cells) named() map[string]m1Cell {
	return map[string]m1Cell{
		"signed out": c.signedOut, "expired": c.expired, "suspended": c.suspended, "no grant": c.noGrant,
		"granted": c.granted, "boundary": c.boundary, "deny": c.deny, "root": c.root, "fresh": c.fresh,
		"csrf": c.csrf, "origin": c.origin, "foreign": c.foreign, "absent": c.absent, "absent employee": c.absentEmployee,
		"invalid": c.invalid, "extra": c.extra, "idempotency": c.idempotency,
	}
}

type m1Request struct{ target, body string }

type m1Edit func(m1Request) m1Request

func m1Segment(index int, value string) m1Edit {
	return func(r m1Request) m1Request {
		parts := strings.Split(r.target, "/")
		parts[index] = value
		r.target = strings.Join(parts, "/")
		return r
	}
}

func m1Body(body string) m1Edit {
	return func(r m1Request) m1Request { r.body = body; return r }
}

func m1Query(query string) m1Edit {
	return func(r m1Request) m1Request { r.target += "?" + query; return r }
}

func m1Replace(old, replacement string) m1Edit {
	return func(r m1Request) m1Request { r.body = strings.Replace(r.body, old, replacement, 1); return r }
}

func m1Extra(r m1Request) m1Request {
	r.body = strings.TrimSuffix(r.body, "}") + `,"extra":1}`
	return r
}

// m1Row is the matrix of a route and how to build its requests: prepare writes a fresh target the success
// cell can change, the edits derive the other requests from it.
type m1Row struct {
	cells          m1Cells
	prepare        func(t *testing.T, w *m1World) m1Request
	absent         m1Edit
	absentEmployee m1Edit
	invalid        []m1Edit
	extra          m1Edit
	shape          *regexp.Regexp
	audit          string
	rootAudit      string
	// keyed routes need an Idempotency-Key: every request carries a new one; reuse is another payload.
	keyed bool
	reuse m1Edit
}

func m1Read() m1Cells {
	return m1Cells{
		signedOut: m1Refused(401), expired: m1Refused(401), suspended: m1Refused(401), granted: m1Ok(), root: m1Ok(),
		boundary:    m1NA("the permission is outside the hrAdministration boundary package"),
		fresh:       m1NA("the policy of the permission carries no fresh@1"),
		csrf:        m1NA("a read takes no CSRF token"),
		origin:      m1NA("a read does not check Origin"),
		extra:       m1NA("the route reads no body"),
		idempotency: m1NA("no M1 route takes an idempotency key"),
	}
}

func m1Write() m1Cells {
	return m1Cells{
		signedOut: m1Refused(401), expired: m1Refused(401), suspended: m1Refused(401), granted: m1Ok(), root: m1Ok(),
		csrf: m1Refused(403), origin: m1Refused(403),
		idempotency: m1NA("no M1 route takes an idempotency key"),
	}
}

func m1Assign(absentEmployee m1Cell, extra m1Cell) m1Cells {
	cells := m1Write()
	cells.noGrant, cells.boundary, cells.deny, cells.fresh = m1Refused(403), m1Refused(403), m1Refused(404), m1Refused(403)
	cells.foreign, cells.absent, cells.absentEmployee, cells.invalid, cells.extra = m1Refused(404), m1Refused(404), absentEmployee, m1Refused(400), extra
	return cells
}

func m1With(cells m1Cells, edit func(*m1Cells)) m1Cells {
	edit(&cells)
	return cells
}

var (
	m1UUID         = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`
	m1Page         = regexp.MustCompile(`^\{"items":\[.*\],"total":"[0-9]+"\}$`)
	m1Version      = regexp.MustCompile(`^\{"version":"[1-9][0-9]*"\}$`)
	m1EmptyTeams   = m1Cell{status: http.StatusOK, body: `{"items":[],"total":"0"}`}
	m1NoSettingKey = "one settings anchor: no record key to be outside the scope"
)

var m1Matrix = map[httpapi.Route]m1Row{
	{Method: http.MethodGet, Path: "/api/administration/settings"}: {
		cells: m1With(m1Read(), func(c *m1Cells) {
			c.noGrant, c.deny = m1Refused(404), m1Refused(404)
			c.foreign, c.absent, c.absentEmployee = m1NA(m1NoSettingKey), m1NA("no key in the path"), m1NA("no employee in the path")
			c.invalid = m1NA("the route reads no parameter, query or body")
		}),
		prepare:   func(*testing.T, *m1World) m1Request { return m1Request{target: "/api/administration/settings"} },
		shape:     regexp.MustCompile(`^\{"settings":\[\{"key":".*\}\],"canUpdate":\{"rule":true,"profile":true\}\}$`),
		rootAudit: "access.setting.read",
	},
	{Method: http.MethodGet, Path: "/api/administration/settings/profile"}: {
		cells: m1With(m1Read(), func(c *m1Cells) {
			c.noGrant, c.deny = m1Refused(404), m1Refused(404)
			c.foreign, c.absent, c.absentEmployee = m1NA(m1NoSettingKey), m1NA("no key in the path"), m1NA("no employee in the path")
			c.invalid = m1NA("the route reads no parameter, query or body")
		}),
		prepare:   func(*testing.T, *m1World) m1Request { return m1Request{target: "/api/administration/settings/profile"} },
		shape:     regexp.MustCompile(`^\{"companyName":"[^"]*","defaultLocale":"(vi|en)"\}$`),
		rootAudit: "access.setting.readProfile",
	},
	{Method: http.MethodGet, Path: "/api/administration/settings/security"}: {
		cells: m1With(m1Read(), func(c *m1Cells) {
			c.noGrant, c.deny = m1Refused(404), m1Refused(404)
			c.foreign, c.absent, c.absentEmployee = m1NA(m1NoSettingKey), m1NA("no key in the path"), m1NA("no employee in the path")
			c.invalid = m1NA("the route reads no parameter, query or body")
		}),
		prepare: func(*testing.T, *m1World) m1Request {
			return m1Request{target: "/api/administration/settings/security"}
		},
		shape:     regexp.MustCompile(`^\{"freshAuthenticationSeconds":[0-9]+,"sessionHours":[0-9]+,"rateLimitWindowMinutes":[0-9]+,"oidcAttemptMinutes":[0-9]+,"idleMinutes":[0-9]+\}$`),
		rootAudit: "access.setting.read",
	},
	{Method: http.MethodGet, Path: "/api/administration/settings/:key/history"}: {
		cells: m1With(m1Read(), func(c *m1Cells) {
			c.noGrant, c.deny = m1Refused(404), m1Refused(404)
			c.foreign, c.absentEmployee = m1NA(m1NoSettingKey), m1NA("no employee in the path")
			c.absent, c.invalid = m1Refused(400), m1Refused(400)
		}),
		prepare: func(*testing.T, *m1World) m1Request {
			return m1Request{target: "/api/administration/settings/hr.wfhMonthLimit/history"}
		},
		absent:    m1Segment(4, "hr.nope"),
		invalid:   []m1Edit{m1Segment(4, "__proto__"), m1Query("limit=101"), m1Query("limit=abc"), m1Query("cursor=1"), m1Query("limit=1&limit=2")},
		shape:     m1Page,
		rootAudit: "access.setting.read",
	},
	{Method: http.MethodPut, Path: "/api/administration/settings/profile/:key"}: {
		cells: m1With(m1Write(), func(c *m1Cells) {
			c.noGrant, c.deny = m1Refused(403), m1Refused(403)
			c.boundary, c.fresh = m1NA("the permission is outside the hrAdministration boundary package"), m1NA("the policy of the permission carries no fresh@1")
			c.foreign, c.absentEmployee = m1NA(m1NoSettingKey), m1NA("no employee in the path")
			c.absent, c.invalid, c.extra = m1Refused(400), m1Refused(400), m1Refused(400)
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{"/api/administration/settings/profile/company.name", `{"value":"Cong ty ` + w.name() + `","expectedVersion":"` + w.settingVersion(t, "company.name") + `"}`}
		},
		absent: m1Segment(5, "company.nope"),
		invalid: []m1Edit{
			m1Segment(5, "hr.wfhMonthLimit"), m1Body(`{"value":7,"expectedVersion":"0"}`), m1Body(`{"value":null,"expectedVersion":"0"}`),
			m1Replace(`"expectedVersion":"`, `"expectedVersion":"0`), m1Body(`{"value":"A"}`), m1Body(`{`), m1Body(`[]`),
		},
		extra:     m1Extra,
		shape:     m1Version,
		audit:     "setting.update",
		rootAudit: "setting.update",
	},
	{Method: http.MethodPut, Path: "/api/administration/settings/rule/:key"}: {
		cells: m1With(m1Write(), func(c *m1Cells) {
			c.noGrant, c.deny = m1Refused(403), m1Refused(403)
			c.boundary, c.fresh = m1NA("the permission is outside the hrAdministration boundary package"), m1NA("the policy of the permission carries no fresh@1")
			c.foreign, c.absentEmployee = m1NA(m1NoSettingKey), m1NA("no employee in the path")
			c.absent, c.invalid, c.extra = m1Refused(400), m1Refused(400), m1Refused(400)
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			version := w.settingVersion(t, "hr.wfhMonthLimit")
			n, err := strconv.Atoi(version)
			if err != nil {
				t.Fatal(err)
			}
			return m1Request{"/api/administration/settings/rule/hr.wfhMonthLimit", `{"value":` + strconv.Itoa(10+n%2) + `,"expectedVersion":"` + version + `"}`}
		},
		absent: m1Segment(5, "hr.nope"),
		invalid: []m1Edit{
			m1Segment(5, "company.name"), m1Body(`{"value":32,"expectedVersion":"0"}`), m1Body(`{"value":6.0,"expectedVersion":"0"}`),
			m1Body(`{"value":"6","expectedVersion":"0"}`), m1Body(`{"value":true,"expectedVersion":"0"}`), m1Body(`{"value":6}`),
			m1Replace(`"expectedVersion":"`, `"expectedVersion":"-`),
		},
		extra:     m1Extra,
		shape:     m1Version,
		audit:     "setting.update",
		rootAudit: "setting.update",
	},
	{Method: http.MethodGet, Path: "/api/hr/teams"}: {
		cells: m1With(m1Read(), func(c *m1Cells) {
			c.noGrant, c.deny = m1EmptyTeams, m1EmptyTeams
			c.foreign = m1NA("no id in the path: the list is filtered by the scope in SQL")
			c.absent, c.absentEmployee = m1NA("no id in the path"), m1NA("no employee in the path")
			c.invalid = m1Refused(400)
		}),
		prepare:   func(*testing.T, *m1World) m1Request { return m1Request{target: "/api/hr/teams"} },
		invalid:   []m1Edit{m1Query("limit=0"), m1Query("limit=abc"), m1Query("limit=101"), m1Query("sort=name"), m1Query("limit=1&limit=2")},
		shape:     m1Page,
		rootAudit: "access.team.read",
	},
	{Method: http.MethodPost, Path: "/api/hr/teams"}: {
		cells: m1With(m1Write(), func(c *m1Cells) {
			c.noGrant, c.deny = m1Refused(403), m1Refused(403)
			c.boundary, c.fresh = m1NA("the permission is outside the hrAdministration boundary package"), m1NA("the policy of the permission carries no fresh@1")
			c.foreign, c.absent = m1NA("the target is the company anchor, not a key of the request"), m1NA("no id in the path")
			c.absentEmployee = m1NA("no employee in the path")
			c.invalid, c.extra = m1Refused(400), m1Refused(400)
		}),
		prepare: func(_ *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/teams", `{"name":"` + w.name() + `"}`}
		},
		invalid: []m1Edit{
			m1Body(`{"name":""}`), m1Body(`{"name":"   "}`), m1Body(`{"name":1}`), m1Body(`{"name":"` + strings.Repeat("x", 201) + `"}`),
			m1Body(`{}`), m1Body(`{"name":"a","name":"b"}`),
		},
		extra:     m1Extra,
		shape:     regexp.MustCompile(`^\{"id":"` + m1UUID + `"\}$`),
		audit:     "hr.team.create",
		rootAudit: "hr.team.create",
	},
	{Method: http.MethodGet, Path: "/api/hr/teams/:id"}: {
		cells: m1With(m1Read(), func(c *m1Cells) {
			c.noGrant, c.deny, c.foreign, c.absent = m1Refused(404), m1Refused(404), m1Refused(404), m1Refused(404)
			c.absentEmployee, c.invalid = m1NA("no employee in the path"), m1Refused(400)
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{target: "/api/hr/teams/" + w.team(t)}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m1Segment(4, "not-a-uuid"), m1Segment(4, strings.ToUpper(m1Absent)+"0")},
		shape:     regexp.MustCompile(`^\{"id":"` + m1UUID + `","name":"[^"]*","version":"[0-9]+","lead":(null|\{.*\}),"members":\[.*\],"leadHistory":\[.*\]\}$`),
		rootAudit: "access.team.read",
	},
	{Method: http.MethodPatch, Path: "/api/hr/teams/:id"}: {
		cells: m1With(m1Write(), func(c *m1Cells) {
			c.noGrant, c.deny, c.foreign, c.absent = m1Refused(404), m1Refused(404), m1Refused(404), m1Refused(404)
			c.boundary, c.fresh = m1NA("the permission is outside the hrAdministration boundary package"), m1NA("the policy of the permission carries no fresh@1")
			c.absentEmployee, c.invalid, c.extra = m1NA("no employee in the path"), m1Refused(400), m1Refused(400)
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/teams/" + w.team(t), `{"expectedVersion":"1","name":"` + w.name() + `"}`}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Segment(4, "not-a-uuid"), m1Replace(`"1"`, `"01"`), m1Replace(`"1"`, `1`), m1Body(`{"name":"x"}`),
			m1Body(`{"expectedVersion":"1","name":""}`), m1Body(`{"expectedVersion":"1"}`),
		},
		extra:     m1Extra,
		shape:     regexp.MustCompile(`^\{"version":"2"\}$`),
		audit:     "hr.team.update",
		rootAudit: "hr.team.update",
	},
	{Method: http.MethodPut, Path: "/api/hr/teams/:id/lead"}: {
		cells: m1Assign(m1NA("the employee is in the body; an absent one is a 409 conflict like a non-member"), m1Refused(400)),
		prepare: func(t *testing.T, w *m1World) m1Request {
			team, employee := w.team(t), w.employee(t)
			w.join(t, team, employee, false)
			return m1Request{"/api/hr/teams/" + team + "/lead", `{"employeeId":"` + employee + `"}`}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m1Segment(4, "not-a-uuid"), m1Body(`{}`), m1Body(`{"employeeId":"x"}`), m1Body(`{"employeeId":1}`), m1Body(`{"lead":null}`)},
		extra:     m1Extra,
		shape:     regexp.MustCompile(`^\{"status":"assigned"\}$`),
		audit:     "hr.team.assign",
		rootAudit: "hr.team.assign",
	},
	{Method: http.MethodPost, Path: "/api/hr/teams/:id/members"}: {
		cells: m1Assign(m1NA("the employee is in the body; an absent one is a 409 conflict like a non-member"), m1Refused(400)),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/teams/" + w.team(t) + "/members", `{"employeeId":"` + w.employee(t) + `","primary":false}`}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Segment(4, "not-a-uuid"), m1Replace(`,"primary":false`, ``), m1Replace(`false`, `null`), m1Replace(`false`, `"false"`),
			m1Body(`{"employeeId":"x","primary":false}`), m1Body(`{"primary":false}`),
		},
		extra:     m1Extra,
		shape:     regexp.MustCompile(`^\{"status":"added"\}$`),
		audit:     "hr.team.assign",
		rootAudit: "hr.team.assign",
	},
	{Method: http.MethodDelete, Path: "/api/hr/teams/:id/members/:employeeId"}: {
		cells: m1Assign(m1Refused(409), m1NA("the route reads no body")),
		prepare: func(t *testing.T, w *m1World) m1Request {
			team, employee := w.team(t), w.employee(t)
			w.join(t, team, employee, false)
			return m1Request{target: "/api/hr/teams/" + team + "/members/" + employee}
		},
		absent:         m1Segment(4, m1Absent),
		absentEmployee: m1Segment(6, m1Absent),
		invalid:        []m1Edit{m1Segment(4, "not-a-uuid"), m1Segment(6, "not-a-uuid")},
		shape:          regexp.MustCompile(`^\{"status":"ended"\}$`),
		audit:          "hr.team.assign",
		rootAudit:      "hr.team.assign",
	},
	{Method: http.MethodPost, Path: "/api/hr/teams/:id/members/:employeeId/primary"}: {
		cells: m1Assign(m1Refused(409), m1NA("the route reads no body")),
		prepare: func(t *testing.T, w *m1World) m1Request {
			first, second, employee := w.team(t), w.team(t), w.employee(t)
			w.join(t, first, employee, false)
			w.join(t, second, employee, false)
			return m1Request{target: "/api/hr/teams/" + second + "/members/" + employee + "/primary"}
		},
		absent:         m1Segment(4, m1Absent),
		absentEmployee: m1Segment(6, m1Absent),
		invalid:        []m1Edit{m1Segment(4, "not-a-uuid"), m1Segment(6, "not-a-uuid")},
		shape:          regexp.MustCompile(`^\{"status":"primary"\}$`),
		audit:          "hr.team.assign",
		rootAudit:      "hr.team.assign",
	},
}

// m1AuthorizeRoutes are the routes served here whose contract class is authorize.
func m1AuthorizeRoutes(t *testing.T) map[httpapi.Route]bool {
	t.Helper()
	contractRoutes, err := httpapi.ParseContractRoutes(contract.Routes())
	if err != nil {
		t.Fatal(err)
	}
	served := map[httpapi.Route]bool{}
	for _, route := range contractRoutes {
		if route.Classification != enforcement.Public() && route.Classification != enforcement.Authenticated() && slices.Contains(httpapi.MigratedRoutes, route.Route) {
			served[route.Route] = true
		}
	}
	return served
}

func TestEveryMigratedAuthorizeRouteHasAFullMatrix(t *testing.T) {
	served := m1AuthorizeRoutes(t)
	matrix := maps.Clone(m1Matrix)
	maps.Copy(matrix, m2Matrix)
	maps.Copy(matrix, m4Matrix)
	maps.Copy(matrix, m5aMatrix)
	maps.Copy(matrix, m5bMatrix)
	if len(served) < 14 {
		t.Errorf("%d authorize routes served", len(served))
	}
	for route := range served {
		row, listed := matrix[route]
		if !listed {
			t.Errorf("%s: served with no matrix", route)
			continue
		}
		for name, cell := range row.cells.named() {
			if cell.empty() {
				t.Errorf("%s: cell %s is neither expected nor marked not applicable", route, name)
			}
		}
		c := row.cells
		problems := map[string]bool{
			"granted and root succeed":           !c.granted.ok || !c.root.ok,
			"a request to prepare":               row.prepare == nil,
			"a shape of success":                 row.shape == nil,
			"a Root audit kind":                  row.rootAudit == "",
			"invalid inputs":                     c.invalid.na == "" && len(row.invalid) == 0,
			"an extra member":                    c.extra.na == "" && row.extra == nil,
			"an absent target":                   c.absent.na == "" && row.absent == nil,
			"an absent employee":                 c.absentEmployee.na == "" && row.absentEmployee == nil,
			"a key and another payload":          (c.idempotency.na == "") != row.keyed || row.keyed != (row.reuse != nil),
			"CSRF, Origin and audit of a write":  route.Method != http.MethodGet && (c.csrf.na != "" || c.origin.na != "" || row.audit == ""),
			"no success cell besides the grants": slices.ContainsFunc([]m1Cell{c.signedOut, c.expired, c.suspended, c.noGrant, c.boundary, c.deny, c.fresh, c.csrf, c.origin, c.foreign, c.absent, c.absentEmployee, c.invalid, c.extra, c.idempotency}, func(cell m1Cell) bool { return cell.ok }),
		}
		for want, missing := range problems {
			if missing {
				t.Errorf("%s: the row lacks %s", route, want)
			}
		}
	}
	for route := range matrix {
		if !served[route] {
			t.Errorf("%s: a matrix for a route not served as authorize", route)
		}
	}
}

type m1World struct {
	stack   *test.Stack
	conn    *pgx.Conn
	handler http.Handler
	token   string
	names   int
	ids     map[string]string
	secrets map[string]string
}

func newM1World(t *testing.T) *m1World {
	t.Helper()
	stack := test.NewDatabase(t)
	running, err := boot(t.Context(), configOver(), quietLogger(), stepsOver(stack))
	if step, failed := errors.AsType[*BootError](err); failed {
		t.Fatalf("boot step %s: %s", step.Step, test.Redact(step.Err))
	}
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		running.release()
		if err := running.listener.Close(); err != nil {
			t.Error(err)
		}
	})
	conn, err := stack.Cluster.ConnectSuperuser(t.Context(), stack.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	})
	w := &m1World{stack: stack, conn: conn, handler: running.server.Handler, token: httpapi.NewCSRF(), ids: map[string]string{}, secrets: map[string]string{}}
	for name, roles := range map[string][]string{
		"hr": {m1Employee, m1Admin}, "unbound": {m1Employee, m1Admin}, "denied": {m1Employee, m1Admin}, "none": nil,
		"scoped": {m1Employee}, "expired": {m1Employee, m1Admin}, "suspended": {m1Employee, m1Admin},
	} {
		w.ids[name] = fixture.Account(t, stack, fixture.AccountSpec{Roles: roles}).ID
	}
	w.ids["root"] = fixture.Root(t, stack).ID
	for _, name := range []string{"hr", "denied", "scoped"} {
		w.exec(t, m1BindBoundary, w.ids[name])
	}
	for permission, template := range m1Denials {
		w.exec(t, m1InsertRule, w.ids["denied"], permission, "deny", template)
	}
	for _, permission := range []string{"team.update", "team.assign"} {
		w.exec(t, m1InsertRule, w.ids["scoped"], permission, "allow", "memberTeams")
	}
	for _, name := range []string{"expired", "suspended"} {
		w.secrets[name] = fixture.Session(t, stack, w.ids[name], fixture.SessionSpec{Fresh: true})
	}
	w.exec(t, m1ExpireAll, w.ids["expired"])
	w.exec(t, m1Suspend, w.ids["suspended"])
	w.signIn(t)
	own := w.team(t)
	w.join(t, own, fixture.Employee(t, stack, fixture.EmployeeSpec{AccountID: w.ids["scoped"]}).ID, false)
	return w
}

// signIn gives fresh sessions, so the step-up of a route checked late in the run is still in its window.
func (w *m1World) signIn(t *testing.T) {
	t.Helper()
	for _, name := range []string{"hr", "unbound", "denied", "none", "scoped", "root"} {
		w.secrets[name] = fixture.Session(t, w.stack, w.ids[name], fixture.SessionSpec{Fresh: true})
	}
	w.secrets["stale"] = fixture.Session(t, w.stack, w.ids["hr"], fixture.SessionSpec{})
}

func (w *m1World) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := w.conn.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(test.Redact(err))
	}
}

func (w *m1World) scalar(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var value string
	if err := w.conn.QueryRow(t.Context(), sql, args...).Scan(&value); err != nil {
		t.Fatal(test.Redact(err))
	}
	return value
}

func (w *m1World) name() string {
	w.names++
	return "Matrix " + strconv.Itoa(w.names)
}

func (w *m1World) settingVersion(t *testing.T, key string) string {
	t.Helper()
	return w.scalar(t, m1SettingAt, key)
}

// send is a browser request of actor ("" is signed out): own CSRF cookie and header, the Origin of the app.
func (w *m1World) send(method, actor string, r m1Request, edit func(*http.Request)) (int, string) {
	request := httptest.NewRequest(method, r.target, strings.NewReader(r.body))
	if r.body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Origin", httpTestOrigin)
	request.Header.Set("X-Csrf-Token", w.token)
	cookie := "authz_csrf=" + w.token
	if actor != "" {
		cookie += "; authz_session=" + w.secrets[actor]
	}
	request.Header.Set("Cookie", cookie)
	if edit != nil {
		edit(request)
	}
	recorder := httptest.NewRecorder()
	w.handler.ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.String()
}

func (w *m1World) asRoot(t *testing.T, method string, r m1Request, want int) string {
	t.Helper()
	status, body := w.send(method, "root", r, nil)
	if status != want {
		t.Fatalf("setup %s %s: %d %s", method, r.target, status, body)
	}
	return body
}

func (w *m1World) team(t *testing.T) string {
	t.Helper()
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(w.asRoot(t, http.MethodPost, m1Request{"/api/hr/teams", `{"name":"` + w.name() + `"}`}, http.StatusCreated)), &created); err != nil {
		t.Fatal(err)
	}
	return created.ID
}

func (w *m1World) employee(t *testing.T) string {
	t.Helper()
	return fixture.Employee(t, w.stack, fixture.EmployeeSpec{}).ID
}

func (w *m1World) join(t *testing.T, team, employee string, primary bool) {
	t.Helper()
	w.asRoot(t, http.MethodPost, m1Request{"/api/hr/teams/" + team + "/members", `{"employeeId":"` + employee + `","primary":` + strconv.FormatBool(primary) + `}`}, http.StatusOK)
}

func m1ContractStatuses(t *testing.T) map[httpapi.Route]int {
	t.Helper()
	var listed []struct {
		Method string `json:"method"`
		Path   string `json:"path"`
		Status int    `json:"status"`
	}
	if err := json.Unmarshal([]byte(contract.Routes()), &listed); err != nil {
		t.Fatal(err)
	}
	statuses := map[httpapi.Route]int{}
	for _, route := range listed {
		statuses[httpapi.Route{Method: route.Method, Path: route.Path}] = route.Status
	}
	return statuses
}

func TestTheM1RoutesAnswerEveryCellOfTheMatrix(t *testing.T) {
	w := newM1World(t)
	statuses := m1ContractStatuses(t)
	for _, route := range httpapi.MigratedRoutes {
		row, listed := m1Matrix[route]
		if !listed {
			continue
		}
		t.Run(route.String(), func(t *testing.T) {
			w.signIn(t)
			w.check(t, route, row, statuses[route])
		})
	}
}

// state is every table a migrated route writes, for the refusals to leave unchanged.
func (w *m1World) state(t *testing.T) string {
	t.Helper()
	return w.scalar(t, m1State) + "|" + w.scalar(t, m2State) + "|" + w.scalar(t, m4State) + "|" + w.scalar(t, m5aState) + "|" + w.scalar(t, m5bState)
}

// keyed adds a new Idempotency-Key to the requests of a keyed route.
func (w *m1World) keyed(t *testing.T, row m1Row, edit func(*http.Request)) func(*http.Request) {
	t.Helper()
	if !row.keyed {
		return edit
	}
	return m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), edit)
}

func m1Key(key string, edit func(*http.Request)) func(*http.Request) {
	return func(r *http.Request) {
		r.Header.Set("Idempotency-Key", key)
		if edit != nil {
			edit(r)
		}
	}
}

func (w *m1World) check(t *testing.T, route httpapi.Route, row m1Row, success int) {
	valid := row.prepare(t, w)
	refuse := func(name, actor string, r m1Request, cell m1Cell, edit func(*http.Request)) {
		t.Helper()
		if cell.na != "" {
			return
		}
		before := w.state(t)
		status, body := w.send(route.Method, actor, r, w.keyed(t, row, edit))
		if !cell.answers(status, body) {
			t.Errorf("%s (%s %s): %d %s", name, route.Method, r.target, status, body)
		}
		if after := w.state(t); after != before {
			t.Errorf("%s changed the state: %s -> %s", name, before, after)
		}
	}
	c := row.cells
	refuse("signed out", "", valid, c.signedOut, nil)
	refuse("expired", "expired", valid, c.expired, nil)
	refuse("suspended", "suspended", valid, c.suspended, nil)
	refuse("no grant", "none", valid, c.noGrant, nil)
	refuse("boundary", "unbound", valid, c.boundary, nil)
	refuse("deny", "denied", valid, c.deny, nil)
	refuse("fresh", "stale", valid, c.fresh, nil)
	refuse("csrf", "hr", valid, c.csrf, func(r *http.Request) { r.Header.Del("X-Csrf-Token") })
	refuse("origin", "hr", valid, c.origin, func(r *http.Request) { r.Header.Set("Origin", m1Attacker) })
	refuse("foreign", "scoped", valid, c.foreign, nil)
	if c.foreign.na == "" {
		absent := m1Segment(4, m1Absent)(valid)
		refuse("foreign actor, absent target", "scoped", absent, c.foreign, nil)
		refuse("no grant, absent target", "none", absent, c.noGrant, nil)
		refuse("boundary, absent target", "unbound", absent, c.boundary, nil)
		refuse("deny, absent target", "denied", absent, c.deny, nil)
		refuse("fresh, absent target", "stale", absent, c.fresh, nil)
	}
	if row.absent != nil {
		refuse("absent", "hr", row.absent(valid), c.absent, nil)
	}
	if row.absentEmployee != nil {
		refuse("absent employee", "hr", row.absentEmployee(valid), c.absentEmployee, nil)
	}
	for i, edit := range row.invalid {
		refuse("invalid "+strconv.Itoa(i), "hr", edit(valid), c.invalid, nil)
	}
	if row.extra != nil {
		refuse("extra", "hr", row.extra(valid), c.extra, nil)
	}
	key := w.keyed(t, row, nil)
	body := w.succeed(t, "granted", "hr", route.Method, valid, row.shape, success, row.audit, key)
	if c.idempotency.na == "" {
		w.checkIdempotency(t, route, row, valid, key, success, body)
	}
	w.succeed(t, "root", "root", route.Method, row.prepare(t, w), row.shape, success, row.rootAudit, w.keyed(t, row, nil))
}

// succeed sends r as actor and wants the success of the contract, its shape, and one audit row of kind by
// the actor ("" for a read by an IAM principal, which is not audited). It returns the body.
func (w *m1World) succeed(t *testing.T, name, actor, method string, r m1Request, shape *regexp.Regexp, success int, kind string, edits ...func(*http.Request)) string {
	t.Helper()
	before := ""
	if kind != "" {
		before = w.scalar(t, m1Audits, w.ids[actor], kind)
	}
	if len(edits) > 1 {
		t.Fatalf("%s: %d edits, at most one", name, len(edits))
	}
	var edit func(*http.Request)
	if len(edits) == 1 {
		edit = edits[0]
	}
	status, body := w.send(method, actor, r, edit)
	if status != success || !shape.MatchString(body) {
		t.Errorf("%s (%s %s): %d %s", name, method, r.target, status, body)
	}
	if kind == "" {
		return body
	}
	n, err := strconv.Atoi(before)
	if err != nil {
		t.Fatal(err)
	}
	if after := w.scalar(t, m1Audits, w.ids[actor], kind); after != strconv.Itoa(n+1) {
		t.Errorf("%s: %s audits by the actor went from %s to %s", name, kind, before, after)
	}
	return body
}

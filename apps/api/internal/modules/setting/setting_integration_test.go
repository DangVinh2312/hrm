//go:build integration

package setting_test

import (
	"context"
	"encoding/json/v2"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/modules/setting"
	"hrm/api/internal/modules/settingcore"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

// settingFixture: H = admin, C = COO, E = employee, N = signed in without HR role, R and P without role
// (each gets one runtime grant where a test needs it). Synthetic people only.
type settingFixture struct {
	s        *test.Stack
	conn     *pgx.Conn
	settings *setting.Service
	ids      map[string]string
	secrets  map[string]string
}

func newSettingFixture(t *testing.T) *settingFixture {
	t.Helper()
	f := &settingFixture{s: test.NewDatabase(t), ids: map[string]string{}, secrets: map[string]string{}}
	var err error
	f.conn, err = f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	must(t, err)
	t.Cleanup(func() { must(t, f.conn.Close(context.WithoutCancel(t.Context()))) })
	for name, roles := range map[string][]string{
		"H": {"hr.employee", "hr.admin"}, "C": {"hr.employee", "hr.coo"}, "E": {"hr.employee"}, "N": nil, "R": nil, "P": nil,
	} {
		account := fixture.Account(t, f.s, fixture.AccountSpec{Roles: roles})
		f.ids[name] = account.ID
		f.secrets[name] = fixture.Session(t, f.s, account.ID, fixture.SessionSpec{})
	}
	c, err := declarations.NewCore()
	must(t, err)
	validated, err := c.Validate(declarations.Source().Declarations)
	must(t, err)
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	must(t, err)
	a, err := authority.New(f.s.Runner, bindings, authority.DefaultCapabilities(), nil, setting.Operations()...)
	must(t, err)
	f.settings = setting.NewService(a)
	return f
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(test.Redact(err))
	}
}

func (f *settingFixture) one(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var value string
	must(t, f.conn.QueryRow(t.Context(), sql, args...).Scan(&value))
	return value
}

func (f *settingFixture) counts(t *testing.T) [3]string {
	t.Helper()
	return [3]string{
		f.one(t, `SELECT count(*)::text FROM system_setting`),
		f.one(t, `SELECT count(*)::text FROM system_setting_history`),
		f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8')='setting.update'`),
	}
}

func (f *settingFixture) update(t *testing.T, who string, key settingcore.Key, value settingcore.Value, expected string) (string, error) {
	t.Helper()
	result, err := f.settings.Update(t.Context(), f.secrets[who], setting.UpdateInput{Key: key, Value: value, ExpectedVersion: expected})
	return result.Version, err
}

func (f *settingFixture) mustUpdate(t *testing.T, who string, key settingcore.Key, value settingcore.Value, expected, want string) {
	t.Helper()
	version, err := f.update(t, who, key, value, expected)
	if err != nil || version != want {
		t.Fatalf("update %s by %s: %q %v", key, who, version, err)
	}
}

func (f *settingFixture) list(t *testing.T, who string) (setting.ListView, bool) {
	t.Helper()
	view, found, err := f.settings.List(t.Context(), f.secrets[who])
	must(t, err)
	return view, found
}

func (f *settingFixture) find(t *testing.T, key settingcore.Key) setting.View {
	t.Helper()
	view, _ := f.list(t, "H")
	for _, item := range view.Settings {
		if item.Key == key {
			return item
		}
	}
	t.Fatalf("no view of %s", key)
	return setting.View{}
}

func (f *settingFixture) history(t *testing.T, who string, key settingcore.Key) (setting.HistoryView, bool) {
	t.Helper()
	view, found, err := f.settings.History(t.Context(), f.secrets[who], setting.HistoryQuery{Key: key, Limit: 20, Offset: 0})
	must(t, err)
	return view, found
}

func marshal(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	must(t, err)
	return string(raw)
}

func TestReadIsRulesAndProfileForAdminAndCooProfileForEveryHRRoleAndNothingWithoutRole(t *testing.T) {
	f := newSettingFixture(t)
	for _, name := range []string{"H", "C"} {
		if view, found := f.list(t, name); !found || len(view.Settings) != 11 {
			t.Fatalf("list %s: %v %d %+v", name, found, len(view.Settings), view.CanUpdate)
		}
	}
	if view, _ := f.list(t, "H"); view.CanUpdate != (setting.CanUpdate{Rule: true, Profile: true}) {
		t.Fatalf("admin may update both groups: %+v", view.CanUpdate)
	}
	if view, _ := f.list(t, "C"); view.CanUpdate != (setting.CanUpdate{}) {
		t.Fatalf("COO updates nothing: %+v", view.CanUpdate)
	}
	if _, found := f.list(t, "E"); found {
		t.Fatal("employee read the rules")
	}
	if _, found, err := f.settings.Security(t.Context(), f.secrets["E"]); found || err != nil {
		t.Fatalf("employee read security: %v %v", found, err)
	}
	if _, found := f.history(t, "E", settingcore.KeyWfhMonthLimit); found {
		t.Fatal("employee read history")
	}
	for _, name := range []string{"H", "C", "E"} {
		view, found, err := f.settings.Profile(t.Context(), f.secrets[name])
		if err != nil || !found || view != (setting.ProfileView{CompanyName: "", DefaultLocale: "vi"}) {
			t.Fatalf("profile %s: %+v %v %v", name, view, found, err)
		}
	}
	if _, found, err := f.settings.Profile(t.Context(), f.secrets["N"]); found || err != nil {
		t.Fatalf("roleless profile: %v %v", found, err)
	}
	if _, found := f.list(t, "N"); found {
		t.Fatal("roleless list")
	}
	root := fixture.Root(t, f.s)
	f.secrets["root"] = fixture.Session(t, f.s, root.ID, fixture.SessionSpec{})
	if view, found := f.list(t, "root"); !found || len(view.Settings) != 11 || view.CanUpdate != (setting.CanUpdate{Rule: true, Profile: true}) {
		t.Fatalf("root list: %v %d %+v", found, len(view.Settings), view.CanUpdate)
	}
}

func TestTheGroupOfAKeyDecidesThePermission(t *testing.T) {
	f := newSettingFixture(t)
	before := f.counts(t)
	for _, name := range []string{"C", "E", "N"} {
		if _, err := f.update(t, name, settingcore.KeyWfhMonthLimit, settingcore.IntValue(5), "0"); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("%s rule: %v", name, err)
		}
		if _, err := f.update(t, name, settingcore.KeyCompanyName, settingcore.TextValue("X"), "0"); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("%s profile: %v", name, err)
		}
	}
	if after := f.counts(t); after != before {
		t.Fatalf("a refused update wrote: %v %v", before, after)
	}
	grant := `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to($2,'UTF8'),$1,'allow',convert_to('setting','UTF8'),1,'{}','runtime')`
	_, err := f.conn.Exec(t.Context(), grant, f.ids["R"], "setting.updateRule")
	must(t, err)
	_, err = f.conn.Exec(t.Context(), grant, f.ids["P"], "setting.updateProfile")
	must(t, err)
	name := "C" + string(rune(0xf4)) + "ng ty Gi" + string(rune(0x1ea3))
	f.mustUpdate(t, "R", settingcore.KeyRequestWindowPastDays, settingcore.IntValue(10), "0", "1")
	if _, err := f.update(t, "R", settingcore.KeyCompanyName, settingcore.TextValue("X"), "0"); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatalf("updateRule wrote a profile key: %v", err)
	}
	f.mustUpdate(t, "P", settingcore.KeyCompanyName, settingcore.TextValue(name), "0", "1")
	if _, err := f.update(t, "P", settingcore.KeyRequestWindowPastDays, settingcore.IntValue(3), "1"); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatalf("updateProfile wrote a rule key: %v", err)
	}
	if _, found := f.list(t, "R"); found {
		t.Fatal("update implied read")
	}
	if _, found, err := f.settings.Profile(t.Context(), f.secrets["P"]); found || err != nil {
		t.Fatalf("update implied readProfile: %v %v", found, err)
	}
	if view, _, err := f.settings.Profile(t.Context(), f.secrets["H"]); err != nil || view.CompanyName != name {
		t.Fatalf("profile after update: %+v %v", view, err)
	}
}

func TestAdminUpdatesWithAPlainSessionAndTheHistoryKeepsEveryStep(t *testing.T) {
	f := newSettingFixture(t)
	f.mustUpdate(t, "H", settingcore.KeyWfhMonthLimit, settingcore.IntValue(6), "0", "1")
	f.mustUpdate(t, "H", settingcore.KeyWfhMonthLimit, settingcore.IntValue(8), "1", "2")
	row := f.find(t, settingcore.KeyWfhMonthLimit)
	if marshal(t, row.Value) != "8" || row.Version != "2" || row.IsDefault || row.UpdatedAt == nil || len(*row.UpdatedAt) != len("2026-11-09T01:02:03.000004Z") {
		t.Fatalf("row: %s", marshal(t, row))
	}
	history, found := f.history(t, "H", settingcore.KeyWfhMonthLimit)
	if !found || history.Total != "2" || len(history.Items) != 2 {
		t.Fatalf("history: %s", marshal(t, history))
	}
	for i, want := range [][3]string{{"2", "6", "8"}, {"1", "4", "6"}} {
		item := history.Items[i]
		if got := [3]string{item.Version, marshal(t, item.OldValue), marshal(t, item.NewValue)}; got != want || !strings.HasSuffix(item.ChangedAt, "Z") {
			t.Errorf("item %d: %v %s", i, got, item.ChangedAt)
		}
	}
	page, _, err := f.settings.History(t.Context(), f.secrets["H"], setting.HistoryQuery{Key: settingcore.KeyWfhMonthLimit, Limit: 1, Offset: 1})
	if err != nil || page.Total != "2" || len(page.Items) != 1 || page.Items[0].Version != "1" {
		t.Fatalf("page: %s %v", marshal(t, page), err)
	}
	if empty, found := f.history(t, "H", settingcore.KeyReportMaxMonths); !found || marshal(t, empty) != `{"items":[],"total":"0"}` {
		t.Fatalf("unwritten key: %s", marshal(t, empty))
	}
	f.mustUpdate(t, "H", settingcore.KeyCompanyName, settingcore.TextValue("A"), "0", "1")
	f.mustUpdate(t, "H", settingcore.KeyCompanyName, settingcore.TextValue(""), "1", "2")
	if view, _, err := f.settings.Profile(t.Context(), f.secrets["H"]); err != nil || view.CompanyName != "" {
		t.Fatalf("empty name: %+v %v", view, err)
	}
}

func TestAStaleVersionAndTheValueInForceAre409AndNothingChanges(t *testing.T) {
	f := newSettingFixture(t)
	f.mustUpdate(t, "H", settingcore.KeyReportMaxMonths, settingcore.IntValue(6), "0", "1")
	before := f.counts(t)
	for _, c := range []struct {
		value    int64
		expected string
		want     error
	}{
		{5, "3", setting.ErrStaleVersion}, {5, "0", setting.ErrStaleVersion}, {5, "2", setting.ErrStaleVersion},
		{6, "1", setting.ErrUnchanged},
	} {
		_, err := f.update(t, "H", settingcore.KeyReportMaxMonths, settingcore.IntValue(c.value), c.expected)
		if !errors.Is(err, c.want) || !errors.Is(err, apperror.ErrCommandRejected) {
			t.Errorf("%d at %s: %v", c.value, c.expected, err)
		}
	}
	if _, err := f.update(t, "H", settingcore.KeyExportMaxRows, settingcore.IntValue(5000), "0"); !errors.Is(err, setting.ErrUnchanged) {
		t.Errorf("default at version 0: %v", err)
	}
	if after := f.counts(t); after != before {
		t.Fatalf("a refused update wrote: %v %v", before, after)
	}
}

func TestTheServiceRevalidatesWhatACallerForges(t *testing.T) {
	f := newSettingFixture(t)
	for _, c := range []struct {
		key   settingcore.Key
		value settingcore.Value
	}{
		{"hr.nope", settingcore.IntValue(1)},
		{settingcore.KeyWfhMonthLimit, settingcore.TextValue("5")},
		{settingcore.KeyWfhMonthLimit, settingcore.IntValue(32)},
		{settingcore.KeyWfhMonthLimit, settingcore.Value{}},
		{settingcore.KeyExportMaxRows, settingcore.IntValue(5001)},
		{settingcore.KeyExportMaxBytes, settingcore.IntValue(5_242_881)},
		{settingcore.KeyReportMaxMonths, settingcore.IntValue(13)},
		{settingcore.KeyRequestMaxDays, settingcore.IntValue(32)},
		{settingcore.KeyCompanyDefaultLocale, settingcore.TextValue("fr")},
		{settingcore.KeyCompanyName, settingcore.TextValue(strings.Repeat("x", 121))},
		{"__proto__", settingcore.IntValue(1)},
		{"security.sessionHours", settingcore.IntValue(1)},
	} {
		if _, err := f.update(t, "H", c.key, c.value, "0"); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%s=%+v: %v", c.key, c.value, err)
		}
	}
	for _, version := range []string{"", "01", "-1", strings.Repeat("1", 19)} {
		if _, err := f.update(t, "H", settingcore.KeyWfhMonthLimit, settingcore.IntValue(5), version); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("version %q: %v", version, err)
		}
	}
	if got := f.counts(t)[0]; got != "0" {
		t.Fatalf("rows: %s", got)
	}
}

func sqlState(err error) (string, string) {
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		return pgErr.Code, pgErr.Message
	}
	return "", ""
}

// The data login is the one the runtime writes with: it has no UPDATE, DELETE or TRUNCATE on the history
// and no DELETE on the current rows (42501 permission denied). The trigger stops the owner as well
// (42501 with its own message), and the CHECKs hold for the owner too (23514).
func TestTheHistoryIsAppendOnlyForTheRuntimeAndTheOwner(t *testing.T) {
	f := newSettingFixture(t)
	f.mustUpdate(t, "H", settingcore.KeyWfhMonthLimit, settingcore.IntValue(6), "0", "1")
	connect := func(login string) *pgx.Conn {
		conn, err := pgx.Connect(t.Context(), f.s.LoginURL(login))
		must(t, err)
		t.Cleanup(func() { must(t, conn.Close(context.WithoutCancel(t.Context()))) })
		return conn
	}
	data, owner := connect("data"), connect("migration")
	for _, sql := range []string{
		`UPDATE system_setting_history SET new_value = '1'::jsonb`,
		`DELETE FROM system_setting_history`,
		`TRUNCATE system_setting_history`,
		`DELETE FROM system_setting`,
		`UPDATE system_setting SET key = key || 'x'`,
	} {
		_, err := data.Exec(t.Context(), sql)
		if code, message := sqlState(err); code != "42501" || !strings.HasPrefix(message, "permission denied for table system_setting") {
			t.Errorf("data %s: %s %s", sql, code, message)
		}
	}
	for _, sql := range []string{
		`UPDATE system_setting_history SET new_value = '1'::jsonb`,
		`DELETE FROM system_setting_history`,
		`TRUNCATE system_setting_history`,
	} {
		_, err := owner.Exec(t.Context(), sql)
		if code, message := sqlState(err); code != "42501" || message != "system_setting_history is append-only" {
			t.Errorf("owner %s: %s %s", sql, code, message)
		}
	}
	for _, c := range [][2]string{{"Bad Key", "1"}, {"nodot", "1"}, {"hr.x", `{"a":1}`}, {"hr.x", "[1]"}, {"hr.x", "null"}} {
		_, err := owner.Exec(t.Context(), `INSERT INTO system_setting(key,value,version,updated_by) VALUES ($1, $2::jsonb, 1, $3)`, c[0], c[1], f.ids["H"])
		if code, _ := sqlState(err); code != "23514" {
			t.Errorf("owner insert %v: %s", c, code)
		}
	}
	if got := f.one(t, `SELECT count(*)::text FROM system_setting_history`); got != "1" {
		t.Fatalf("history rows: %s", got)
	}
}

// The audit writer fails by losing its INSERT privilege on audit_outbox, the table it appends to.
func TestAFailingAuditRollsBackTheCurrentRowAndTheHistory(t *testing.T) {
	f := newSettingFixture(t)
	key := settingcore.KeyRequestWindowFutureDays
	f.mustUpdate(t, "H", key, settingcore.IntValue(60), "0", "1")
	f.mustUpdate(t, "H", key, settingcore.IntValue(90), "1", "2")
	before := f.counts(t)
	_, err := f.conn.Exec(t.Context(), `REVOKE INSERT ON audit_outbox FROM product_data`)
	must(t, err)
	_, err = f.update(t, "H", key, settingcore.IntValue(30), "2")
	_, regrant := f.conn.Exec(t.Context(), `GRANT INSERT ON audit_outbox TO product_data`)
	must(t, regrant)
	if code, _ := sqlState(err); code != "42501" || errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatalf("update without audit: %v", test.Redact(err))
	}
	if after := f.counts(t); after != before {
		t.Fatalf("a failed audit kept the write: %v %v", before, after)
	}
	if row := f.find(t, key); marshal(t, row.Value) != "90" || row.Version != "2" {
		t.Fatalf("row: %s", marshal(t, row))
	}
	f.mustUpdate(t, "H", key, settingcore.IntValue(30), "2", "3")
	if got := f.counts(t)[2]; got != "3" {
		t.Fatalf("audits: %s", got)
	}
	metadata := f.one(t, `SELECT safe_metadata::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8')='setting.update' ORDER BY occurred_at DESC LIMIT 1`)
	for _, value := range []string{"hr.requestWindowFutureDays", "30", "90"} {
		if strings.Contains(metadata, `"`+value+`"`) {
			t.Errorf("audit carries %s", value)
		}
	}
	if got := f.one(t, `SELECT count(*)::text FROM audit_outbox a JOIN setting_anchor s ON s.object_id=a.object_id WHERE convert_from(a.event_kind,'UTF8')='setting.update'`); got != "3" {
		t.Fatalf("audit target is not the settings anchor: %s", got)
	}
}

func TestTwoConcurrentWritesOfOneKeyAtOneVersionHaveExactlyOneWinner(t *testing.T) {
	f := newSettingFixture(t)
	key := settingcore.KeyExportMaxRows
	f.mustUpdate(t, "H", key, settingcore.IntValue(4500), "0", "1")
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, value := range []int64{4000, 3000} {
		wg.Go(func() { _, errs[i] = f.update(t, "H", key, settingcore.IntValue(value), "1") })
	}
	wg.Wait()
	won, stale := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			won++
		case errors.Is(err, setting.ErrStaleVersion):
			stale++
		default:
			t.Errorf("unexpected: %v", test.Redact(err))
		}
	}
	if won != 1 || stale != 1 {
		t.Fatalf("won %d stale %d", won, stale)
	}
	if history, _ := f.history(t, "H", key); history.Total != "2" {
		t.Fatalf("history: %s", history.Total)
	}
	if row := f.find(t, key); row.Version != "2" {
		t.Fatalf("version: %s", row.Version)
	}
}

func TestTheSecurityPageIsAViewOnlyAllowlistOfTheValuesInForce(t *testing.T) {
	f := newSettingFixture(t)
	view, found, err := f.settings.Security(t.Context(), f.secrets["H"])
	if err != nil || !found || view != setting.SecurityPolicy() {
		t.Fatalf("security: %+v %v %v", view, found, err)
	}
	raw := marshal(t, view)
	if raw != `{"freshAuthenticationSeconds":300,"sessionHours":12,"rateLimitWindowMinutes":15,"oidcAttemptMinutes":5,"idleMinutes":30}` || strings.Contains(raw, "secret") {
		t.Fatalf("security: %s", raw)
	}
	if _, err := f.update(t, "H", "security.sessionHours", settingcore.IntValue(1), "0"); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Fatalf("security written: %v", err)
	}
}

//go:build integration

package settingcore_test

import (
	"context"
	"errors"
	"testing"

	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/settingcore"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const (
	upsertSetting = `INSERT INTO system_setting(key,value,version,updated_by) VALUES($1,CAST($2 AS jsonb),1,$3)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`
	deleteSetting = `DELETE FROM system_setting WHERE key=$1`
)

func read(t *testing.T, s *test.Stack, keys ...settingcore.Key) (map[settingcore.Key]settingcore.Value, error) {
	t.Helper()
	return database.Run(t.Context(), s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (map[settingcore.Key]settingcore.Value, error) {
		return settingcore.Read(tx, keys)
	}, database.RunOptions{})
}

// The rows are written by the cluster superuser: the product logins have no INSERT on system_setting,
// and the table only checks that a value is a number or a string, so a value outside the registry's
// range is what "changed behind the application" looks like.
func TestReadGivesDefaultsWithoutARowStoredValuesWithOneAndFailsClosedOnACorruptRow(t *testing.T) {
	s := test.NewDatabase(t)
	actor := fixture.Account(t, s, fixture.AccountSpec{})
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatalf("connect: %s", test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(t.Context()); err != nil {
			t.Error(test.Redact(err))
		}
	})
	put := func(key, jsonb string) {
		t.Helper()
		if _, err := conn.Exec(t.Context(), upsertSetting, key, jsonb, actor.ID); err != nil {
			t.Fatalf("write %s: %s", key, test.Redact(err))
		}
	}
	keys := []settingcore.Key{settingcore.KeyRequestMaxDays, settingcore.KeyCompanyDefaultLocale}

	got, err := read(t, s, keys...)
	if err != nil {
		t.Fatalf("defaults: %s", test.Redact(err))
	}
	if len(got) != 2 || got[settingcore.KeyRequestMaxDays] != settingcore.IntValue(31) || got[settingcore.KeyCompanyDefaultLocale] != settingcore.TextValue("vi") {
		t.Fatalf("defaults: %+v", got)
	}

	put("hr.requestMaxDays", "10")
	put("company.defaultLocale", `"en"`)
	got, err = read(t, s, keys...)
	if err != nil {
		t.Fatalf("stored: %s", test.Redact(err))
	}
	if got[settingcore.KeyRequestMaxDays] != settingcore.IntValue(10) || got[settingcore.KeyCompanyDefaultLocale] != settingcore.TextValue("en") {
		t.Fatalf("stored: %+v", got)
	}

	got, err = read(t, s, settingcore.KeyRequestMaxDays, settingcore.KeyWfhMonthLimit)
	if err != nil || got[settingcore.KeyRequestMaxDays] != settingcore.IntValue(10) || got[settingcore.KeyWfhMonthLimit] != settingcore.IntValue(4) {
		t.Fatalf("mixed: %+v, %v", got, err)
	}

	for name, corrupt := range map[string]string{"above the ceiling": "99", "a string for an int": `"10"`, "a fraction": "10.5"} {
		put("hr.requestMaxDays", corrupt)
		if got, err := read(t, s, keys...); !errors.Is(err, settingcore.ErrStoredInvalid) || got != nil {
			t.Fatalf("%s: %+v, %v", name, got, err)
		}
	}
	put("hr.requestMaxDays", "10")
	put("company.defaultLocale", `"fr"`)
	if _, err := read(t, s, keys...); !errors.Is(err, settingcore.ErrStoredInvalid) {
		t.Fatalf("locale outside the enum: %v", err)
	}
	if got, err := read(t, s, settingcore.KeyRequestMaxDays); err != nil || got[settingcore.KeyRequestMaxDays] != settingcore.IntValue(10) {
		t.Fatalf("a corrupt row nobody asked for must not matter: %+v, %v", got, err)
	}
	if _, err := conn.Exec(t.Context(), deleteSetting, "company.defaultLocale"); err != nil {
		t.Fatal(test.Redact(err))
	}
	if got, err := read(t, s, keys...); err != nil || got[settingcore.KeyCompanyDefaultLocale] != settingcore.TextValue("vi") {
		t.Fatalf("after delete: %+v, %v", got, err)
	}
}

func TestReadRefusesAKeyOutsideTheRegistry(t *testing.T) {
	s := test.NewDatabase(t)
	if got, err := read(t, s, "security.sessionHours"); !errors.Is(err, settingcore.ErrUnknownSetting) || got != nil {
		t.Fatalf("%+v, %v", got, err)
	}
}

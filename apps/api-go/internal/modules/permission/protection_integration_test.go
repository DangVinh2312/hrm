//go:build integration

package permission_test

import (
	"context"
	"testing"

	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/permission"
	"hrm/api-go/test"
)

func TestPermissionProtectionAndSchemasMatchMigratedDatabase(t *testing.T) {
	s := test.NewDatabase(t)
	pool := s.Pools[database.PurposeData]
	for _, verify := range []func(context.Context, database.Pools) error{
		func(ctx context.Context, p database.Pools) error {
			return permission.VerifyProtection(ctx, p[database.PurposeData])
		},
		func(ctx context.Context, p database.Pools) error {
			return permission.VerifyWorkCalendarSchema(ctx, p[database.PurposeData])
		},
		func(ctx context.Context, p database.Pools) error {
			return permission.VerifySettingSchema(ctx, p[database.PurposeData])
		},
	} {
		if err := verify(t.Context(), s.Pools); err != nil {
			t.Fatal(test.Redact(err))
		}
	}
	if pool == nil {
		t.Fatal("missing data pool")
	}
	for range 2 {
		for _, ensure := range []func(*database.Tx) error{permission.EnsureCompany, permission.EnsureWorkCalendar, permission.EnsureSetting, permission.EnsureRole} {
			_, err := database.Run(t.Context(), s.Runner, database.ModeSync, func(_ context.Context, tx *database.Tx) (struct{}, error) { return struct{}{}, ensure(tx) }, database.RunOptions{})
			if err != nil {
				t.Fatal(test.Redact(err))
			}
		}
	}
}

func TestRegisterOnlyAcceptsTheDeclaredRuntimeRecordTypes(t *testing.T) {
	s := test.NewDatabase(t)
	if _, err := permission.Register(nil, "employee;DROP TABLE employee", "00000000-0000-4000-8000-000000000123"); err == nil {
		t.Fatal("unknown registration resource accepted")
	}
	object, err := database.Run(t.Context(), s.Runner, database.ModeWrite, func(_ context.Context, tx *database.Tx) (string, error) {
		return permission.Register(tx, "employee", "00000000-0000-4000-8000-000000000123")
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if object == "" {
		t.Fatal("registration returned no object")
	}
}

func TestPermissionProbeRejectsWidenedOwnerAndChangedView(t *testing.T) {
	for _, sql := range []string{
		"GRANT UPDATE ON object_ref TO product_object_owner",
		"ALTER VIEW hr_employee_lead SET (security_invoker=false)",
	} {
		s := test.NewDatabase(t)
		connection, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		_, execErr := connection.Exec(t.Context(), sql)
		closeErr := connection.Close(context.WithoutCancel(t.Context()))
		if execErr != nil || closeErr != nil {
			t.Fatal("could not install probe fault")
		}
		if err := permission.VerifyProtection(t.Context(), s.Pools[database.PurposeData]); err == nil {
			t.Fatal("permission drift accepted")
		}
	}
}

func TestSchemaProbesRejectMissingConstraintAndDisabledHistoryProtection(t *testing.T) {
	s := test.NewDatabase(t)
	connection, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := connection.Exec(t.Context(), "ALTER TABLE work_calendar_change DROP CONSTRAINT ck_work_calendar_change_kind"); err != nil {
		t.Fatal(test.Redact(err))
	}
	if err := permission.VerifyWorkCalendarSchema(t.Context(), s.Pools[database.PurposeData]); err == nil {
		t.Fatal("missing calendar constraint accepted")
	}
	if _, err := connection.Exec(t.Context(), "ALTER TABLE system_setting_history DISABLE TRIGGER forbid_setting_history_truncate"); err != nil {
		t.Fatal(test.Redact(err))
	}
	if err := permission.VerifySettingSchema(t.Context(), s.Pools[database.PurposeData]); err == nil {
		t.Fatal("disabled history protection accepted")
	}
}

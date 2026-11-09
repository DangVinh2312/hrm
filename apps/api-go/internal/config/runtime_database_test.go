package config

import "testing"

func TestRuntimeSyncRefusesOfflineCredentialsAndWrongRuntimeLogins(t *testing.T) {
	valid := map[string]string{
		"PRODUCT_DATA_DATABASE_URL":      "postgres://product_data:fixture@127.0.0.1/hrm",
		"PRODUCT_IDENTITY_DATABASE_URL":  "postgres://product_identity:fixture@127.0.0.1/hrm",
		"PRODUCT_AUTHORITY_DATABASE_URL": "postgres://product_authority:fixture@127.0.0.1/hrm",
		"PRODUCT_SYNC_DATABASE_URL":      "postgres://product_sync:fixture@127.0.0.1/hrm",
	}
	if _, err := RuntimeDatabases(valid); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{
		"DATABASE_ADMIN_URL": "present", "PRODUCT_MIGRATION_DATABASE_URL": "present", "PRODUCT_BOOTSTRAP_DATABASE_URL": "present", "PRODUCT_OUTBOX_DATABASE_URL": "present",
		"PRODUCT_DATA_DATABASE_URL": "postgres://product_sync:fixture@127.0.0.1/hrm",
		"PRODUCT_SYNC_DATABASE_URL": "postgres://product_sync:fixture@127.0.0.1/other",
	} {
		t.Run(key, func(t *testing.T) {
			old := valid[key]
			valid[key] = value
			defer func() { valid[key] = old }()
			if _, err := RuntimeDatabases(valid); err == nil {
				t.Fatal("unsafe sync credential accepted")
			}
		})
	}
}

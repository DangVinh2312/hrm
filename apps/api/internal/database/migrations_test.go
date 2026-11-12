package database_test

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"testing"

	"hrm/api/internal/database"
)

var pinnedMigrations = map[string]string{
	"1792108800001_product_baseline.sql":        "305f9310789b644b345ccb53eb2d89f394bb2fbe5a8d63a8f23b08ec6f7076fc",
	"1792108800002_application_baseline.sql":    "73c7c9f45719552701ddf4d29f3e2ea00fab9111bcf74273f3f3eecfd23e3c90",
	"1792108800003_role_runtime_constraint.sql": "5bc1b772387d3d8e38cf75be93105b4ef7693b7d0f9fec8c1af3669b54d10921",
	"1792108800004_role_anchor_lock.sql":        "a5d870ba780c8f03ca60a2381d202aedb6c3e8881f01e69edfb272326a85c932",
	"1792108800005_identity_operations.sql":     "fccb5f62871b49a4651754026c85810d1372e38a8dd71b7289849bbf468aa6e0",
	"1792108800006_account_role_required.sql":   "6d059a880c3708f248ecc7623ad7f80ddb57085502aed8a43649b5ded0d0858c",
	"1792108800007_work_schedule.sql":           "ff106d4277bab28f589e2bf0f8403334839ee0168a869e33820b8623da22e006",
	"1792108800008_ascii_login_email.sql":       "ae7637c2bb7f75c004c25daf5f8322843b7b2e8af5be88cea56b221e62fc5efd",
}

const migrationRule = "a migration once applied is never edited or removed; a change is a new file, with its line added to pinnedMigrations"

func TestEveryMigrationIsPinned(t *testing.T) {
	files, err := database.Migrations()
	if err != nil {
		t.Fatal(err)
	}
	names, err := fs.Glob(files, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool, len(names))
	for _, name := range names {
		seen[name] = true
		content, err := fs.ReadFile(files, name)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(content)
		got := hex.EncodeToString(sum[:])
		want, pinned := pinnedMigrations[name]
		switch {
		case !pinned:
			t.Errorf("%s is not pinned (sha256 %s): %s", name, got, migrationRule)
		case got != want:
			t.Errorf("%s changed (sha256 %s, pinned %s): %s", name, got, want, migrationRule)
		}
	}
	for name := range pinnedMigrations {
		if !seen[name] {
			t.Errorf("%s is pinned but gone: %s", name, migrationRule)
		}
	}
}

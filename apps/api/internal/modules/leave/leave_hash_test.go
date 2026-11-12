package leave

import "testing"

func text(points ...rune) string { return string(points) }

// The hashes are what LeaveService.adjust of the TypeScript build (apps/api/dist) computed for the same
// input, so a retry of a key first claimed by NestJS still replays on Go. The last reference holds the
// characters encoding/json v1 escapes and JSON.stringify does not.
func TestTheAdjustmentHashIsTheBytesOfTheTypeScriptBuild(t *testing.T) {
	const id = "0b8d1a4e-5c3f-4a7b-9e21-3f6d8c2a1b09"
	for _, tc := range []struct {
		minutes     int
		effectiveOn string
		reference   string
		hash        string
	}{
		{480, "2026-03-10", text('Q', 0x110, '-', '2', '0', '2', '6', '/', '0', '3'), "2cf208442dd0346714546be93cbd44b9c8f2cf0e8893d17481f59abf7bd2ee63"},
		{-240, "2026-03-10", text('S', 0x1eed, 'a', ' ', 's', 0x1ed1, ' ', 'c', 0x169), "4042017d5f8b858e7a046b7a33cfe9d3a86d8391a1253282c7a269979e6fbd9d"},
		{175680, "2026-12-31", text('N', 'g', 'h', 'i', 0x302, 0x300, ' ', 'p', 'h', 0xe9, 'p', ' ', 0x1f44d, 0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), "c79fcd0f8416d0a49f1217ac36dff199eeb245266af4e9dd3d719ec8d21cf5a1"},
		{-175680, "2026-01-01", text('<', 'a', '>', '&', '"', 'b', '"', '\\', 'c', 0x2028, 'd', 0x2029, 'e', 0x85, 'f', 0xa0, 'g'), "3124d5bb433fc476624bef6267adc648b4eee2581ec38ea1f0311926378692e4"},
	} {
		input := AdjustmentInput{EmployeeID: id, IdempotencyKey: id, Minutes: tc.minutes, EffectiveOn: tc.effectiveOn, Reference: tc.reference}
		got, err := adjustmentHash(input)
		if err != nil || got != tc.hash {
			t.Errorf("%d %q: %s, %v", tc.minutes, tc.reference, got, err)
		}
		input.IdempotencyKey = "6d2f0c1e-8a7b-4c3d-9e5f-1a2b3c4d5e6f"
		if again, err := adjustmentHash(input); err != nil || again != got {
			t.Errorf("the key changed the hash: %s, %v", again, err)
		}
	}
}

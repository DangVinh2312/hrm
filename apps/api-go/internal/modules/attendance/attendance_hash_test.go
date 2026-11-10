package attendance

import "testing"

// The hashes are sha256(JSON.stringify([employeeId, workDate, minutes, reason, reference])) computed by
// Node for the same values, as AttendanceService.adjust hashes them, so a retry of a key first claimed by
// NestJS still replays on Go. An omitted reference is null, which is not the string "null".
func TestTheAdjustmentHashIsTheBytesOfJSONStringify(t *testing.T) {
	const id = "0b8d1a4e-5c3f-4a7b-9e21-3f6d8c2a1b09"
	reference := func(value string) *string { return &value }
	symbols := text('<', 'a', '>', '&', '"', 'b', '"', '\\', 'c', 0x2028, 'd', 0x2029, 'e', 0x85, 'f', 0xa0, 'g')
	for _, tc := range []struct {
		workDate  string
		minutes   int
		reason    string
		reference *string
		hash      string
	}{
		{
			"2026-11-03", -60, text('Q', 'u', 0xea, 'n', ' ', 'c', 'h', 0x1ea5, 'm', ' ', 'c', 0xf4, 'n', 'g', ' ', 'b', 'u', 0x1ed5, 'i', ' ', 'c', 'h', 'i', 0x1ec1, 'u'),
			reference(text('Q', 0x110, '-', '2', '0', '2', '6', '/', '1', '1')),
			"d8bd8618676daf77c2307d0e9a832833e96dd7a89946b15a5f7a7ec7a310bb53",
		},
		{
			"2024-02-29", 1440, text('N', 'g', 'h', 'i', 0x302, 0x300, ' ', 'p', 'h', 0xe9, 'p'), nil,
			"9614670bbd4605d55137528fc4e77d2247963e52d09001744c1830819d624130",
		},
		{
			"2026-12-31", -1440, text('W', 'F', 'H', ' ', 0x1f44d, 0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
			reference(text('S', 0x1ed1, ' ', '1', '2', '#', 'A', ':', 'b', '_', 'c', '.', 'd')),
			"70e7f8400d14cd6bdd762db4177899838efe99cd3f46466a94be527b837d7180",
		},
		{"2026-01-01", 1, symbols, nil, "af320656f416fe5ae8527dbc104285c186ca283fec4ebd737cbc723747c4135f"},
		{"2026-01-01", 1, symbols, reference("null"), "c56f40427a960797f7160e0c32bb811498ec90d18a573ec9febc957585084d2b"},
	} {
		input := AdjustmentInput{
			EmployeeID: id, IdempotencyKey: id, WorkDate: tc.workDate, Minutes: tc.minutes, Reason: tc.reason, Reference: tc.reference,
		}
		got, err := adjustmentHash(input)
		if err != nil || got != tc.hash {
			t.Errorf("%d %q: %s, %v", tc.minutes, tc.reason, got, err)
		}
		input.IdempotencyKey = "6d2f0c1e-8a7b-4c3d-9e5f-1a2b3c4d5e6f"
		if again, err := adjustmentHash(input); err != nil || again != got {
			t.Errorf("the key changed the hash: %s, %v", again, err)
		}
	}
}

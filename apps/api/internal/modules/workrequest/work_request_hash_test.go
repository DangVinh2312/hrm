package workrequest

import (
	"testing"

	"hrm/api/internal/modules/hrbase"
)

// The hashes are what payloadHash of the TypeScript build (apps/api/dist) computed for the bodies after
// parseSubmitRequest, so a retry of a key first claimed by NestJS still replays on Go. The submit hash has
// no acknowledgement member: only the decision of 13c carries one.
func TestTheSubmitHashIsTheBytesOfTheTypeScriptBuild(t *testing.T) {
	team := team
	for _, tc := range []struct {
		input SubmitInput
		hash  string
	}{
		{
			SubmitInput{Kind: hrbase.RequestLateArrival, Reason: text(0x110, 0x1b0, 'a', ' ', 'c', 'o', 'n', ' ', 0x111, 'i', ' ', 'h', 0x1ecd, 'c'), Date: "2026-11-03", ExpectedMinute: 600},
			"d088132b959411bb4bdead52e9698524c0037c451f2b4e239ed8ca0a30439b75",
		},
		{
			SubmitInput{Kind: hrbase.RequestEarlyDeparture, TeamID: &team, Reason: text('N', 'g', 'h', 'i', 0x302, 0x300, ' ', 's', 0x1edb, 'm'), Date: "2026-11-04", ExpectedMinute: 1020},
			"6b5d919b562c4e4fd435465f4541c17ab741802d94ad0b3658d5d7c90680c627",
		},
		{
			SubmitInput{Kind: hrbase.RequestWfh, Reason: text('W', 'F', 'H', ' ', 0x1f44d, 0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), Dates: []string{"2026-11-16", "2026-11-17"}},
			"feeb1c6bb31d6afb478b3004ef40a21b7c8c92d2da2b0097558bca243793cfc6",
		},
		{
			SubmitInput{Kind: hrbase.RequestAnnualLeave, TeamID: &team, Reason: text('<', 'a', '>', '&', '"', 'b', '"', '\\', 'c', 0x2028, 'd', 0x2029, 'e', 0x85, 'f', 0xa0, 'g'), Segments: []Slot{{"2026-11-30", 540, 780}, {"2026-12-01", 540, 1080}}},
			"653895191446f50b6dae3c7cada9b791d4a57519403998aad3dccfdb81eaa992",
		},
		{
			SubmitInput{Kind: hrbase.RequestUnpaidLeave, Reason: text('V', 'i', 0x1ec7, 'c', ' ', 'r', 'i', 0xea, 'n', 'g'), Segments: []Slot{{"2026-11-03", 0, 1440}}},
			"248cc8e0ba9dc729ac7336986c8d93b1f2b4634ae485cd20a5d89cf0f9bd81de",
		},
	} {
		got, err := payloadHash(tc.input)
		if err != nil || got != tc.hash {
			t.Errorf("%s %q: %s, %v", tc.input.Kind, tc.input.Reason, got, err)
		}
		tc.input.IdempotencyKey = someKey
		if again, err := payloadHash(tc.input); err != nil || again != got {
			t.Errorf("the key changed the hash: %s, %v", again, err)
		}
	}
}

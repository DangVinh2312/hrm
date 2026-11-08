package offline_test

import (
	"errors"
	"testing"

	"hrm/api-go/internal/offline"
)

func TestPurgeExpiredSessionsRefusesBoundsOutsideTheContract(t *testing.T) {
	for _, c := range [][2]int{{-1, 1}, {3651, 1}, {0, 0}, {0, 1001}} {
		if _, err := offline.PurgeExpiredSessions(t.Context(), nil, c[0], c[1]); !errors.Is(err, offline.ErrInvalidPurge) {
			t.Errorf("retention %d, batch %d: %v", c[0], c[1], err)
		}
	}
}

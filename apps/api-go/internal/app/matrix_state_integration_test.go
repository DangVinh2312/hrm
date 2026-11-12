//go:build integration

package app

import (
	"strings"
	"testing"
)

func TestTheMatrixSnapshotMatchesEveryIndividualQuery(t *testing.T) {
	w := newM1World(t)
	read := func() string {
		var parts []string
		for _, query := range []string{m1State, m2State, m4State, m5aState, m5bState, m6State, m8State} {
			parts = append(parts, w.scalar(t, query))
		}
		want := strings.Join(parts, "|")
		got := w.state(t)
		if got != want {
			t.Fatal("matrix snapshot differs from the individual queries")
		}
		return got
	}
	before := read()
	w.team(t)
	if read() == before {
		t.Fatal("matrix snapshot missed a team write and its audit")
	}
}

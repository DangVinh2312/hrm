//go:build integration

package test_test

import (
	"strings"
	"testing"
	"time"

	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

func TestOpeningPoolsOutlastsAServerThatAnswersLate(t *testing.T) {
	stack := test.NewDatabase(t)
	proxy, err := test.StartWireProxy(stack.Cluster.Address())
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := proxy.Close(); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	url := strings.Replace(stack.LoginURL("data"), stack.Cluster.Address(), proxy.Address(), 1)
	proxy.Hold()
	released := time.AfterFunc(3*time.Second, proxy.Release)
	defer released.Stop()
	logs := &countedLogs{TB: t}
	pools, err := test.OpenPoolsWaiting(t.Context(), logs, map[database.Purpose]string{database.PurposeData: url})
	if err != nil {
		t.Fatalf("%v", err)
	}
	pools.Close()
	if len(logs.lines) == 0 || !strings.Contains(logs.lines[0], "deadline") {
		t.Errorf("%q", logs.lines)
	}
}

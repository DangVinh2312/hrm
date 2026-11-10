package health_test

import (
	"bytes"
	"encoding/json"
	"slices"
	"strconv"
	"sync"
	"testing"

	"hrm/api-go/internal/database"
	"hrm/api-go/internal/health"
)

func counts(row health.MetricRow) []int64 {
	var got []int64
	for _, bucket := range row.Buckets {
		got = append(got, bucket.Count)
	}
	return got
}

func TestAnEmptySnapshotIsAnEmptyList(t *testing.T) {
	body, err := json.Marshal((&health.Metrics{}).Snapshot())
	if err != nil || string(body) != "[]" {
		t.Errorf("%s %v", body, err)
	}
}

func TestBucketsCountValuesUpToTheirUpperBound(t *testing.T) {
	metrics := &health.Metrics{}
	for _, value := range []float64{0.5, 1, 5, 5.5, 5000, 5000.1} {
		metrics.Observe(database.MetricTransaction, database.ModeRead, value)
	}
	rows := metrics.Snapshot()
	if len(rows) != 1 {
		t.Fatalf("%+v", rows)
	}
	row := rows[0]
	if row.Metric != "transaction" || row.Mode != "read" || row.Count != 6 || row.Sum != 0.5+1+5+5.5+5000+5000.1 {
		t.Errorf("%+v", row)
	}
	var uppers []float64
	for _, bucket := range row.Buckets {
		uppers = append(uppers, bucket.Upper)
	}
	if !slices.Equal(uppers, []float64{1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000}) {
		t.Errorf("%v", uppers)
	}
	if want := []int64{2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5}; !slices.Equal(counts(row), want) {
		t.Errorf("%v, want %v", counts(row), want)
	}
}

func TestRowsAreOnePerMetricAndModeInByteOrder(t *testing.T) {
	metrics := &health.Metrics{}
	metrics.Observe(database.MetricTransaction, database.ModeWrite, 2)
	metrics.Observe(database.MetricRetry, database.ModeRead, 1)
	metrics.Observe(database.MetricTransaction, database.ModeRead, 3)
	metrics.Observe(database.MetricLockHold, database.ModeAdmin, 4)
	metrics.Observe(database.MetricLockWait, database.ModeAdmin, 4)
	metrics.Observe(database.MetricTransaction, database.ModeRead, 7)
	body, err := json.Marshal(metrics.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	var rows []struct {
		Metric string `json:"metric"`
		Mode   string `json:"mode"`
		Count  int64  `json:"count"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		keys = append(keys, row.Metric+":"+row.Mode+":"+strconv.FormatInt(row.Count, 10))
	}
	if want := []string{"lock_hold:admin:1", "lock_wait:admin:1", "retry:read:1", "transaction:read:2", "transaction:write:1"}; !slices.Equal(keys, want) {
		t.Errorf("%v", keys)
	}
	if !bytes.HasPrefix(body, []byte(`[{"metric":"lock_hold","mode":"admin","count":1,"sum":4,"buckets":[{"upper":1,"count":0},{"upper":5,"count":1},`)) {
		t.Errorf("%s", body)
	}
}

func TestObserveIsSafeUnderConcurrency(t *testing.T) {
	metrics := &health.Metrics{}
	var wait sync.WaitGroup
	for range 16 {
		wait.Go(func() {
			for range 200 {
				metrics.Observe(database.MetricTransaction, database.ModeRead, 1)
				_ = metrics.Snapshot()
			}
		})
	}
	wait.Wait()
	rows := metrics.Snapshot()
	if len(rows) != 1 || rows[0].Count != 3200 || rows[0].Sum != 3200 || rows[0].Buckets[0].Count != 3200 {
		t.Errorf("%+v", rows)
	}
}

func TestASnapshotIsACopy(t *testing.T) {
	metrics := &health.Metrics{}
	metrics.Observe(database.MetricRetry, database.ModeWrite, 1)
	before := metrics.Snapshot()
	metrics.Observe(database.MetricRetry, database.ModeWrite, 1)
	if before[0].Count != 1 || before[0].Buckets[0].Count != 1 {
		t.Errorf("%+v", before)
	}
}

package health

import (
	"slices"
	"strings"
	"sync"

	"hrm/api/internal/database"
)

var metricBuckets = [...]float64{1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000}

type metricKey struct {
	metric database.Metric
	mode   database.Mode
}

type metricValue struct {
	count   int64
	sum     float64
	buckets [len(metricBuckets)]int64
}

// Metrics holds cumulative histograms of the runner. Its labels are the finite Metric and Mode values, so
// the set of rows is bounded; the zero value is ready to use.
type Metrics struct {
	mutex  sync.Mutex
	values map[metricKey]*metricValue
}

type MetricBucket struct {
	Upper float64 `json:"upper"`
	Count int64   `json:"count"`
}

type MetricRow struct {
	Metric  string         `json:"metric"`
	Mode    string         `json:"mode"`
	Count   int64          `json:"count"`
	Sum     float64        `json:"sum"`
	Buckets []MetricBucket `json:"buckets"`
}

// Observe has the signature of database.RunnerOptions.OnMetric; value is milliseconds or a count of one.
func (m *Metrics) Observe(metric database.Metric, mode database.Mode, value float64) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	if m.values == nil {
		m.values = map[metricKey]*metricValue{}
	}
	key := metricKey{metric, mode}
	row, ok := m.values[key]
	if !ok {
		row = &metricValue{}
		m.values[key] = row
	}
	row.count++
	row.sum += value
	for index, upper := range metricBuckets {
		if value <= upper {
			row.buckets[index]++
		}
	}
}

// Snapshot orders rows by "metric:mode" in byte order.
func (m *Metrics) Snapshot() []MetricRow {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	rows := make([]MetricRow, 0, len(m.values))
	for key, value := range m.values {
		buckets := make([]MetricBucket, len(metricBuckets))
		for index, upper := range metricBuckets {
			buckets[index] = MetricBucket{upper, value.buckets[index]}
		}
		rows = append(rows, MetricRow{string(key.metric), string(key.mode), value.count, value.sum, buckets})
	}
	slices.SortFunc(rows, func(a, b MetricRow) int {
		return strings.Compare(a.Metric+":"+a.Mode, b.Metric+":"+b.Mode)
	})
	return rows
}

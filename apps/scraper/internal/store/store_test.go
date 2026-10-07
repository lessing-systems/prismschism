package store

import (
	"reflect"
	"testing"
	"time"

	"prismschism/scraper/internal/parser"
)

// indexOfMetric returns the index of the "metric" column in cols, or -1.
func indexOfMetric(cols []string) int {
	for i, c := range cols {
		if c == "metric" {
			return i
		}
	}
	return -1
}

// sampleRow builds a Row whose every stored field carries a distinct,
// recognizable value so positional wiring can be asserted exactly.
func sampleRow() parser.Row {
	return parser.Row{
		TS:           time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC),
		MetricName:   "litellm_llm_api_time_to_first_token_metric_sum",
		Model:        "gpt-4",
		ModelID:      "dep-1",
		APIProvider:  "openai",
		Value:        3.5,
		Unit:         "s_sum",
		HashedAPIKey: "hk-1",
		APIKeyAlias:  "alias-1",
		User:         "user-1",
		Team:         "team-1",
		Family:       "latency",
	}
}

// TestLatencyColumnsCarryMetric asserts the latency family has its own column
// layout that carries a "metric" column (metricColumns + 1).
func TestLatencyColumnsCarryMetric(t *testing.T) {
	cases := []struct {
		name string
	}{
		{name: "latency columns contain metric and equal metricColumns+1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cols := familyColumns["latency"].columns
			if indexOfMetric(cols) < 0 {
				t.Fatalf("latency columns missing \"metric\": %v", cols)
			}
			if got, want := len(cols), len(metricColumns)+1; got != want {
				t.Fatalf("len(latency columns) = %d, want %d (metricColumns+1)", got, want)
			}
		})
	}
}

// TestLatencyMetricIndexMatchesTokenColumns asserts position parity: the metric
// column sits at the same index in the latency layout as in tokenColumns, so
// the values funcs line up.
func TestLatencyMetricIndexMatchesTokenColumns(t *testing.T) {
	tokIdx := indexOfMetric(tokenColumns)
	if tokIdx < 0 {
		t.Fatalf("tokenColumns missing metric (sanity): %v", tokenColumns)
	}
	latIdx := indexOfMetric(familyColumns["latency"].columns)
	if latIdx != tokIdx {
		t.Errorf("latency metric index = %d, want %d (tokenColumns parity)", latIdx, tokIdx)
	}
}

// TestLatencyValuesWiring asserts the latency values func writes Row.MetricName
// into the metric slot and keeps every other field in the same order as the
// metricColumns values func (proxied by the requests family).
func TestLatencyValuesWiring(t *testing.T) {
	row := sampleRow()
	latVals := familyColumns["latency"].values(row)
	reqVals := familyColumns["requests"].values(row) // metricColumns order

	metricIdx := indexOfMetric(familyColumns["latency"].columns)
	if metricIdx < 0 {
		t.Fatalf("latency columns missing metric: %v", familyColumns["latency"].columns)
	}
	if len(latVals) != len(reqVals)+1 {
		t.Fatalf("len(latency values) = %d, want %d (requests+1)", len(latVals), len(reqVals)+1)
	}
	if got := latVals[metricIdx]; got != row.MetricName {
		t.Errorf("latency values[%d] = %v, want MetricName %q", metricIdx, got, row.MetricName)
	}
	withoutMetric := append(append([]any{}, latVals[:metricIdx]...), latVals[metricIdx+1:]...)
	if !reflect.DeepEqual(withoutMetric, reqVals) {
		t.Errorf("latency values (metric removed) = %v, want metricColumns order %v", withoutMetric, reqVals)
	}
}

// TestNonTokenFamiliesHaveNoMetric is a regression guard: requests/spend/limits
// must NOT gain a metric column.
func TestNonTokenFamiliesHaveNoMetric(t *testing.T) {
	for _, fam := range []string{"requests", "spend", "limits"} {
		if indexOfMetric(familyColumns[fam].columns) >= 0 {
			t.Errorf("family %q columns unexpectedly contain \"metric\": %v", fam, familyColumns[fam].columns)
		}
	}
}

// TestLatencyWhitelisted guards the family whitelist.
func TestLatencyWhitelisted(t *testing.T) {
	if !familyWhitelist["latency"] {
		t.Errorf("familyWhitelist[\"latency\"] = false, want true")
	}
}

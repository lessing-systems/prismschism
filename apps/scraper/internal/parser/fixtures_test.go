package parser

import (
	"testing"
	"time"
)

// fixtureB is a minimal inline Prometheus exposition using real Litellm metric
// names for testing tripwire and series-count logic.
const fixtureB = `
# HELP litellm_proxy_total_requests_metric_total Total requests
# TYPE litellm_proxy_total_requests_metric_total counter
litellm_proxy_total_requests_metric_total{api_key_alias="prod",api_provider="openai",hashed_api_key="hash1",model="gpt-4",team="t1",user="alice"} 100
# HELP litellm_input_tokens_metric_total Input tokens
# TYPE litellm_input_tokens_metric_total counter
litellm_input_tokens_metric_total{api_key_alias="prod",api_provider="openai",hashed_api_key="hash1",model="gpt-4",team="t1",user="alice"} 55
`

// fixtureC is a fixture with 10 counter series (for tripwire testing).
const fixtureC = `
# HELP litellm_proxy_total_requests_metric_total Total requests
# TYPE litellm_proxy_total_requests_metric_total counter
` +
	`litellm_proxy_total_requests_metric_total{api_provider="openai",hashed_api_key="h1",model="m1"} 1
litellm_proxy_total_requests_metric_total{api_provider="openai",hashed_api_key="h2",model="m2"} 2
litellm_proxy_total_requests_metric_total{api_provider="openai",hashed_api_key="h3",model="m3"} 3
litellm_proxy_total_requests_metric_total{api_provider="openai",hashed_api_key="h4",model="m4"} 4
litellm_proxy_total_requests_metric_total{api_provider="openai",hashed_api_key="h5",model="m5"} 5
litellm_input_tokens_metric_total{api_provider="openai",hashed_api_key="h1",model="m1"} 6
litellm_input_tokens_metric_total{api_provider="openai",hashed_api_key="h2",model="m2"} 7
litellm_input_tokens_metric_total{api_provider="openai",hashed_api_key="h3",model="m3"} 8
litellm_input_tokens_metric_total{api_provider="openai",hashed_api_key="h4",model="m4"} 9
litellm_input_tokens_metric_total{api_provider="openai",hashed_api_key="h5",model="m5"} 10
`

func TestSeriesCount(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	res, err := Parse(fixtureB, ts, NewTripwire(10))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	// fixtureB has 2 series (one per counter line).
	if res.SeriesCount != 2 {
		t.Errorf("SeriesCount = %d, want 2", res.SeriesCount)
	}
}

func TestTripwireDropsExcess(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tw := NewTripwire(2)

	// Establish baseline with a 1-series input.
	_, err := Parse("litellm_mystery_thing 1\n", ts, tw)
	if err != nil {
		t.Fatalf("first Parse: %v", err)
	}

	// fixtureC has 10 series > 2*1, so the tripwire trips and allows 2.
	res, err := Parse(fixtureC, ts, tw)
	if err != nil {
		t.Fatalf("second Parse: %v", err)
	}
	if !res.TripwireTripped {
		t.Error("TripwireTripped = false, want true")
	}
	if res.SeriesCount != 10 {
		t.Errorf("SeriesCount = %d, want 10 (full count regardless of drop)", res.SeriesCount)
	}
	if len(res.Rows) > 2 {
		t.Errorf("len(Rows) = %d, want <= 2 (allowed budget)", len(res.Rows))
	}
}

func TestUnknownMetricSkipped(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	input := "# TYPE litellm_mystery_thing gauge\nlitellm_mystery_thing 1\n"
	res, err := Parse(input, ts, NewTripwire(10))
	if err != nil {
		t.Fatalf("Parse of unknown metric returned error: %v", err)
	}
	if len(res.Rows) != 0 {
		t.Errorf("unknown metric produced %d rows, want 0", len(res.Rows))
	}
}

func TestHealthCheckRowsSkipped(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	input := `# TYPE litellm_requests_metric_total counter
litellm_requests_metric_total{api_provider="openai",hashed_api_key="litellm-internal-health-check",model="Raw-Upstream-Name"} 0
litellm_requests_metric_total{api_provider="openai",hashed_api_key="h1",model="gpt-4"} 5
`
	res, err := Parse(input, ts, NewTripwire(10))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0].Model != "gpt-4" {
		t.Fatalf("want only the gpt-4 row, got %+v", res.Rows)
	}
}

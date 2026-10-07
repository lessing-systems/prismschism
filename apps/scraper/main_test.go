package main

import (
	"context"
	"math"
	"testing"
	"time"

	"prismschism/scraper/internal/backoff"
	"prismschism/scraper/internal/delta"
	"prismschism/scraper/internal/fetcher"
	"prismschism/scraper/internal/parser"
	"prismschism/scraper/internal/store"
	"prismschism/scraper/internal/targets"
)

// mkRow builds a parser.Row for the delta-filter tests. Only the fields the
// tests care about are set (Family, MetricName, IsCounter, Value); one label
// (HashedAPIKey) is populated so that Row.SeriesKey() yields a distinct, stable
// series identity per scenario.
func mkRow(family, metric string, isCounter bool, value float64, keyLabel string) parser.Row {
	return parser.Row{
		Family:       family,
		MetricName:   metric,
		IsCounter:    isCounter,
		Value:        value,
		HashedAPIKey: keyLabel,
	}
}

// TestApplyDeltasFirstCycle is case (a): a fresh tracker. Every counter row is
// skipped as the first-sample baseline (it only seeds state, storing nothing);
// the gauge row is kept raw.
func TestApplyDeltasFirstCycle(t *testing.T) {
	tr := delta.NewTracker()
	rows := []parser.Row{
		mkRow("tokens", "litellm_input_tokens_metric_total", true, 100, "keyA"),
		mkRow("requests", "litellm_requests_metric_total", true, 10, "keyB"),
		mkRow("limits", "litellm_remaining_tokens_metric", false, 42.5, "keyC"),
	}
	kept, skipped := applyDeltas(tr, rows)
	if skipped != 2 {
		t.Fatalf("skipped = %d, want 2 (the two counter rows)", skipped)
	}
	if len(kept) != 1 {
		t.Fatalf("len(kept) = %d, want 1 (the gauge row)", len(kept))
	}
	if got := kept[0].Value; got != 42.5 {
		t.Errorf("gauge Value = %v, want 42.5 (stored raw)", got)
	}
}

// TestApplyDeltasSecondCycleIncrements is case (b): on a second cycle the
// counters that increase produce small per-interval deltas that are kept, and
// the gauge is still stored raw.
func TestApplyDeltasSecondCycleIncrements(t *testing.T) {
	tr := delta.NewTracker()

	// First cycle: the counter seeds its baseline and is skipped; the gauge is
	// kept. This is the state the second cycle computes against.
	_, _ = applyDeltas(tr, []parser.Row{
		mkRow("tokens", "litellm_input_tokens_metric_total", true, 100, "keyA"),
		mkRow("limits", "litellm_remaining_tokens_metric", false, 42.5, "keyC"),
	})

	// Second cycle: token counter rose 100 -> 127 (delta 27); gauge re-read.
	kept, skipped := applyDeltas(tr, []parser.Row{
		mkRow("tokens", "litellm_input_tokens_metric_total", true, 127, "keyA"),
		mkRow("limits", "litellm_remaining_tokens_metric", false, 40.0, "keyC"),
	})
	if skipped != 0 {
		t.Fatalf("skipped = %d, want 0 (deltas are storeable)", skipped)
	}
	if len(kept) != 2 {
		t.Fatalf("len(kept) = %d, want 2 (counter delta + gauge)", len(kept))
	}
	// Row order is preserved: counter first, gauge second.
	if got := kept[0].Value; got != 27 {
		t.Errorf("counter delta = %v, want 27 (127-100)", got)
	}
	if got := kept[1].Value; got != 40.0 {
		t.Errorf("gauge Value = %v, want 40.0 (stored raw)", got)
	}
}

// TestApplyDeltasGaugeKeptRaw is case (c): a gauge row is always kept with its
// raw value — no delta is computed for gauges, on the first cycle and beyond.
func TestApplyDeltasGaugeKeptRaw(t *testing.T) {
	tr := delta.NewTracker()
	kept, skipped := applyDeltas(tr, []parser.Row{
		mkRow("latency", "litellm_llm_api_latency_metric", false, 3.14, "keyD"),
	})
	if skipped != 0 {
		t.Fatalf("skipped = %d, want 0 (gauges are never skipped)", skipped)
	}
	if len(kept) != 1 {
		t.Fatalf("len(kept) = %d, want 1", len(kept))
	}
	if got := kept[0].Value; got != 3.14 {
		t.Errorf("gauge Value = %v, want 3.14 (raw)", got)
	}
}

// TestApplyDeltasEpochCounterFirstSample is case (d): a counter whose FIRST
// sample is an epoch-garbage magnitude. A unix timestamp of 1.79e9 is below
// the 1e15 absurd limit, so the guard does NOT fire — the row is instead
// skipped as the counter's first-sample baseline. The bogus epoch only seeds
// the baseline; the next cycle's delta is computed against it per delta policy
// (a later reset, raw < last, is treated as this cycle's increase).
func TestApplyDeltasEpochCounterFirstSample(t *testing.T) {
	tr := delta.NewTracker()

	// First cycle: epoch-garbage first sample (1.79e9 < 1e15, so NOT
	// guard:absurd) → skipped as first-sample-baseline, nothing stored.
	kept1, skipped1 := applyDeltas(tr, []parser.Row{
		mkRow("latency", "some_counter_metric", true, 1.79e9, "keyE"),
	})
	if len(kept1) != 0 {
		t.Fatalf("first-cycle kept = %d rows, want 0", len(kept1))
	}
	if skipped1 != 1 {
		t.Fatalf("first-cycle skipped = %d, want 1", skipped1)
	}

	// Second cycle: the counter resets far below the epoch baseline
	// (raw < last) → delta policy treats raw as this cycle's increase.
	kept2, skipped2 := applyDeltas(tr, []parser.Row{
		mkRow("latency", "some_counter_metric", true, 3, "keyE"),
	})
	if skipped2 != 0 {
		t.Fatalf("second-cycle skipped = %d, want 0", skipped2)
	}
	if len(kept2) != 1 {
		t.Fatalf("second-cycle len(kept) = %d, want 1", len(kept2))
	}
	if got := kept2[0].Value; got != 3 {
		t.Errorf("reset delta = %v, want 3 (raw treated as increase)", got)
	}
}

// TestApplyDeltasGuardAbsurd asserts the 1e15 absurd guard: a counter sample
// strictly above 1e15 is rejected as guard:absurd and never stored — even when
// it appears on a later cycle after a valid baseline.
func TestApplyDeltasGuardAbsurd(t *testing.T) {
	tr := delta.NewTracker()

	// First cycle: a valid sample establishes the baseline and is skipped as
	// first-sample.
	_, _ = applyDeltas(tr, []parser.Row{
		mkRow("tokens", "some_counter_metric", true, 100, "keyF"),
	})

	// Second cycle: an absurd magnitude (> 1e15) is guard-rejected and, per
	// documented policy, never updates the stored state.
	kept, skipped := applyDeltas(tr, []parser.Row{
		mkRow("tokens", "some_counter_metric", true, 2e15, "keyF"),
	})
	if len(kept) != 0 {
		t.Fatalf("kept = %d rows, want 0 (absurd value rejected)", len(kept))
	}
	if skipped != 1 {
		t.Fatalf("skipped = %d, want 1", skipped)
	}

	// Third cycle: the baseline survived the rejected sample, so the next
	// valid sample is a delta against 100.
	kept2, skipped2 := applyDeltas(tr, []parser.Row{
		mkRow("tokens", "some_counter_metric", true, 150, "keyF"),
	})
	if skipped2 != 0 {
		t.Fatalf("third-cycle skipped = %d, want 0", skipped2)
	}
	if len(kept2) != 1 {
		t.Fatalf("third-cycle len(kept) = %d, want 1", len(kept2))
	}
	if got := kept2[0].Value; got != 50 {
		t.Errorf("delta = %v, want 50 (150-100; baseline survived the rejected sample)", got)
	}
}

// TestApplyDeltasGuardNaNInfNegative asserts the NaN / Inf / negative guards
// reject the corresponding rows regardless of counter vs gauge.
func TestApplyDeltasGuardNaNInfNegative(t *testing.T) {
	tr := delta.NewTracker()
	rows := []parser.Row{
		mkRow("tokens", "nan_counter", true, math.NaN(), "keyN"),
		mkRow("requests", "inf_counter", true, math.Inf(1), "keyI"),
		mkRow("limits", "neg_gauge", false, -5, "keyV"),
	}
	kept, skipped := applyDeltas(tr, rows)
	if len(kept) != 0 {
		t.Fatalf("kept = %d rows, want 0 (all guard-rejected)", len(kept))
	}
	if skipped != 3 {
		t.Fatalf("skipped = %d, want 3", skipped)
	}
}

// TestRunCycleWritesTickHeartbeatWithNoTargets proves the scraper-liveness
// starvation fix at the cycle level: a tick with zero targets still writes
// exactly one health row — the per-cycle liveness heartbeat (backend
// heartbeatBackend, status statusTick) — so a zero-target tick is non-starving
// and the scraper's own liveness stays observable in instance_health.
func TestRunCycleWritesTickHeartbeatWithNoTargets(t *testing.T) {
	wh := &store.Fake{}
	fetch := fetcher.New(fetcher.DefaultTimeout)
	tw := parser.NewTripwire(10)
	tracker := backoff.NewTracker(backoff.DefaultPolicy())
	deltaTracker := delta.NewTracker()
	lastAttempt := make(map[string]time.Time)

	// Nil target list: no targets to fan out, only the tick heartbeat is written.
	runCycle(context.Background(), nil, wh, fetch, tw, tracker, deltaTracker, lastAttempt)

	if len(wh.Health) != 1 {
		t.Fatalf("len(Health) = %d, want 1 (one tick heartbeat with no targets)", len(wh.Health))
	}
	if len(wh.Metrics) != 0 {
		t.Fatalf("len(Metrics) = %d, want 0 (no metric rows with no targets)", len(wh.Metrics))
	}
	h := wh.Health[0]
	if h.Backend != heartbeatBackend {
		t.Errorf("Backend = %q, want %q", h.Backend, heartbeatBackend)
	}
	if h.Up {
		t.Errorf("Up = true, want false (a tick heartbeat is not an up-scrape)")
	}
	if h.Status != statusTick {
		t.Errorf("Status = %q, want %q", h.Status, statusTick)
	}
	if h.HealthValue != 0 {
		t.Errorf("HealthValue = %v, want 0", h.HealthValue)
	}
}

// TestScrapeTargetBackoffWritesHealthRow proves the scraper-liveness starvation
// fix at the per-target level: a target that is still inside its backoff window
// is skipped (no fetch, no metric rows) but STILL writes a health row (backend
// = target name, status statusBackoff), so the skipped tick remains observable.
//
// The backoff-skip path returns before any fetch, so the URL and APIKey are
// never touched: an unreachable URL and a KeyEnv that never resolves are both
// harmless, and no network I/O happens.
func TestScrapeTargetBackoffWritesHealthRow(t *testing.T) {
	wh := &store.Fake{}
	fetch := fetcher.New(fetcher.DefaultTimeout)
	tw := parser.NewTripwire(10)
	tracker := backoff.NewTracker(backoff.DefaultPolicy())
	deltaTracker := delta.NewTracker()

	const name = "unreachable-backend"
	// One recorded failure makes Wait(name) positive (DefaultPolicy: 1s base).
	tracker.RecordFailure(name)

	// lastAttempt just set, so "now" is still well inside the 1s backoff window.
	lastAttempt := make(map[string]time.Time)
	lastAttempt[name] = time.Now()

	target := targets.Target{
		Name:   name,
		URL:    "http://127.0.0.1:1/unreachable/metrics",
		KeyEnv: "SCRAPER_TEST_UNSET_KEY",
	}

	scrapeTarget(context.Background(), target, wh, fetch, tw, tracker, deltaTracker, lastAttempt)

	if len(wh.Health) != 1 {
		t.Fatalf("len(Health) = %d, want 1 (one backoff health row)", len(wh.Health))
	}
	if len(wh.Metrics) != 0 {
		t.Fatalf("len(Metrics) = %d, want 0 (backoff skip writes no metric rows)", len(wh.Metrics))
	}
	h := wh.Health[0]
	if h.Backend != name {
		t.Errorf("Backend = %q, want %q", h.Backend, name)
	}
	if h.Up {
		t.Errorf("Up = true, want false (a backoff-skip row is not an up-scrape)")
	}
	if h.Status != statusBackoff {
		t.Errorf("Status = %q, want %q", h.Status, statusBackoff)
	}
	if h.HealthValue != 0 {
		t.Errorf("HealthValue = %v, want 0", h.HealthValue)
	}
}

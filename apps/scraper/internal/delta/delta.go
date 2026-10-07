// Package delta computes per-interval deltas for scraped time-series samples.
//
// It maintains in-memory, per-series last-sample state (keyed by a caller-built
// seriesKey of the form "table|metric|sorted labels") and decides, for each
// incoming raw sample, whether the derived value should be stored downstream.
//
// Semantics:
//
// GUARD — applied to every incoming raw value (and, defensively, to any
// computed delta). A value is rejected when it is:
//
//	NaN            → Reason "guard:nan"
//	+Inf / -Inf    → Reason "guard:inf"
//	negative       → Reason "guard:negative"
//	> 1e15         → Reason "guard:absurd"   (exactly 1e15 passes)
//
// Rejected samples yield Store=false, Value=0, and — documented policy —
// NEVER update stored state: the last known-good baseline survives so the
// next valid sample computes against it. Reasons are machine-readable and
// never contain the series key or any label values.
//
// COUNTER series (isCounter=true):
//
//	First-ever sample   → Store=false, Reason "first-sample-baseline".
//	                    Policy choice: never store a bogus full-lifetime
//	                    value; the first sample only seeds the baseline.
//	raw > last          → Store=true, Value = raw - last.
//	raw == last         → Store=true, Value = 0.
//	raw < last (reset)  → Store=true, Value = raw (the new raw value is
//	                    treated as this cycle's increase).
//	On any accepted sample, stored state is updated to raw.
//
// GAUGE series (isCounter=false):
//
//	No delta is computed; the guarded raw value is stored as-is
//	(Store=true, Value=raw). The last value is still recorded (harmless;
//	kept so future per-gauge analytics remain possible).
//
// Per-series isolation: state is keyed strictly by seriesKey; distinct keys
// never interfere. State is in-memory only and lives for the process
// lifetime. Tracker is safe for concurrent use.
package delta

import (
	"math"
	"sync"
)

// absurdLimit rejects values strictly above this magnitude as implausible
// (guards against overflow sentinels like INT64_MAX ≈ 9.223e18).
const absurdLimit = 1e15

// Result is the outcome of evaluating one sample for one series.
type Result struct {
	Store  bool
	Value  float64
	Reason string // machine-readable, NO secret label values (never include the full series key)
}

// Tracker holds per-series last-sample state and computes deltas.
// It is safe for concurrent use.
type Tracker struct {
	mu    sync.Mutex
	lasts map[string]float64
}

// NewTracker returns an empty Tracker.
func NewTracker() *Tracker {
	return &Tracker{lasts: make(map[string]float64)}
}

// guard classifies v; returns "" when v passes the guard.
func guard(v float64) string {
	switch {
	case math.IsNaN(v):
		return "guard:nan"
	case math.IsInf(v, 0):
		return "guard:inf"
	case v < 0:
		return "guard:negative"
	case v > absurdLimit:
		return "guard:absurd"
	default:
		return ""
	}
}

// Apply computes the per-interval delta for one series sample.
// seriesKey: caller-built unique key (table|metric|sorted labels).
// isCounter: true for counters and histogram sum/count parts; false for gauges.
func (t *Tracker) Apply(seriesKey string, isCounter bool, raw float64) Result {
	if r := guard(raw); r != "" {
		// Guarded input never touches stored state (documented policy).
		return Result{Store: false, Value: 0, Reason: r}
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	prev, seen := t.lasts[seriesKey]

	if !isCounter {
		t.lasts[seriesKey] = raw
		return Result{Store: true, Value: raw}
	}

	if !seen {
		t.lasts[seriesKey] = raw
		return Result{Store: false, Value: 0, Reason: "first-sample-baseline"}
	}

	var d float64
	switch {
	case raw >= prev:
		d = raw - prev
	default: // counter reset: treat raw as this cycle's increase
		d = raw
	}

	// Defensive: re-guard the computed delta (unreachable while both
	// operands pass the input guard, but kept for safety).
	if r := guard(d); r != "" {
		return Result{Store: false, Value: 0, Reason: r}
	}

	t.lasts[seriesKey] = raw
	return Result{Store: true, Value: d}
}

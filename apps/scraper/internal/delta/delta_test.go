package delta

import (
	"math"
	"strings"
	"sync"
	"testing"
)

func TestCounterNormalIncrease(t *testing.T) {
	tr := NewTracker()
	const key = "table|metric|a=1"

	// Prime baseline (first sample is always skipped).
	if r := tr.Apply(key, true, 100); r.Store || r.Reason != "first-sample-baseline" {
		t.Fatalf("baseline: got %+v", r)
	}

	r := tr.Apply(key, true, 142)
	if !r.Store {
		t.Fatalf("expected store, got %+v", r)
	}
	if r.Value != 42 {
		t.Fatalf("expected delta 42, got %v", r.Value)
	}
	if r.Reason != "" {
		t.Fatalf("expected empty reason on success, got %q", r.Reason)
	}
}

func TestCounterEqualDeltaZero(t *testing.T) {
	tr := NewTracker()
	const key = "table|metric|b=2"

	tr.Apply(key, true, 7)
	r := tr.Apply(key, true, 7)
	if !r.Store {
		t.Fatalf("equal sample should store, got %+v", r)
	}
	if r.Value != 0 {
		t.Fatalf("expected delta 0, got %v", r.Value)
	}
}

func TestCounterResetBaseline(t *testing.T) {
	tr := NewTracker()
	const key = "table|metric|c=3"

	tr.Apply(key, true, 100) // baseline
	r := tr.Apply(key, true, 3)
	if !r.Store || r.Value != 3 {
		t.Fatalf("reset: expected store value 3, got %+v", r)
	}
	r = tr.Apply(key, true, 10)
	if !r.Store || r.Value != 7 {
		t.Fatalf("post-reset: expected store value 7, got %+v", r)
	}
}

func TestFirstSampleSkipped(t *testing.T) {
	tr := NewTracker()
	r := tr.Apply("table|metric|fresh", true, 500)
	if r.Store {
		t.Fatalf("first counter sample must not store, got %+v", r)
	}
	if r.Reason != "first-sample-baseline" {
		t.Fatalf("expected reason first-sample-baseline, got %q", r.Reason)
	}
	if r.Value != 0 {
		t.Fatalf("expected zero Value on skip, got %v", r.Value)
	}
}

func TestSeriesIsolationAcrossCycles(t *testing.T) {
	tr := NewTracker()
	const keyA = "t|mA|l=1"
	const keyB = "t|mB|l=2"

	type step struct {
		key   string
		raw   float64
		store bool
		val   float64
	}
	steps := []step{
		// cycle 1: baselines
		{keyA, 10, false, 0},
		{keyB, 1000, false, 0},
		// cycle 2: increases
		{keyA, 25, true, 15},
		{keyB, 1500, true, 500},
		// cycle 3: A resets, B keeps increasing
		{keyA, 4, true, 4},
		{keyB, 1500, true, 0},
		// cycle 4: after reset both increase
		{keyA, 9, true, 5},
		{keyB, 2600, true, 1100},
	}
	for i, s := range steps {
		r := tr.Apply(s.key, true, s.raw)
		if r.Store != s.store || r.Value != s.val {
			t.Fatalf("step %d (key=%s raw=%v): expected store=%v val=%v, got %+v", i, s.key, s.raw, s.store, s.val, r)
		}
	}
}

func TestGaugePassthrough(t *testing.T) {
	tr := NewTracker()
	const key = "table|remaining_budget|model=x"

	// First gauge sample stores immediately (no baseline skip for gauges).
	r := tr.Apply(key, false, 3500.0)
	if !r.Store || r.Value != 3500.0 || r.Reason != "" {
		t.Fatalf("gauge passthrough: got %+v", r)
	}
	r = tr.Apply(key, false, 2750.5)
	if !r.Store || r.Value != 2750.5 {
		t.Fatalf("gauge second sample: got %+v", r)
	}
	// Negative gauge value → guard skip.
	r = tr.Apply(key, false, -1)
	if r.Store || r.Reason != "guard:negative" {
		t.Fatalf("negative gauge: got %+v", r)
	}
}

func assertGuard(t *testing.T, r Result, wantReason string) {
	t.Helper()
	if r.Store {
		t.Fatalf("expected Store=false for %s, got %+v", wantReason, r)
	}
	if r.Reason != wantReason {
		t.Fatalf("expected reason %q, got %q", wantReason, r.Reason)
	}
	if r.Value != 0 {
		t.Fatalf("expected Value=0 on guard skip, got %v", r.Value)
	}
	// Reason must never leak the series key or label values.
	if strings.Contains(r.Reason, "series") || strings.Contains(r.Reason, "=") {
		t.Fatalf("reason leaks key/label content: %q", r.Reason)
	}
}

func TestGuardNaN(t *testing.T) {
	tr := NewTracker()
	assertGuard(t, tr.Apply("t|m|nan=1", true, math.NaN()), "guard:nan")
	assertGuard(t, tr.Apply("t|m|nan=2", false, math.NaN()), "guard:nan")
}

func TestGuardInf(t *testing.T) {
	tr := NewTracker()
	assertGuard(t, tr.Apply("t|m|pinf", true, math.Inf(1)), "guard:inf")
	assertGuard(t, tr.Apply("t|m|ninf", true, math.Inf(-1)), "guard:inf")
	assertGuard(t, tr.Apply("t|m|pinf-g", false, math.Inf(1)), "guard:inf")
}

func TestGuardNegative(t *testing.T) {
	tr := NewTracker()
	assertGuard(t, tr.Apply("t|m|neg", true, -0.5), "guard:negative")
	assertGuard(t, tr.Apply("t|m|neg-g", false, -3500), "guard:negative")
}

func TestGuardAbsurd(t *testing.T) {
	tr := NewTracker()
	assertGuard(t, tr.Apply("t|m|abs1", true, 1e15+1), "guard:absurd")
	// INT64_MAX-style sentinel (9.223e18) commonly seen from overflow bugs.
	assertGuard(t, tr.Apply("t|m|abs2", true, 9.223e18), "guard:absurd")
	assertGuard(t, tr.Apply("t|m|abs-g", false, 9.223e18), "guard:absurd")
	// Exactly 1e15 is NOT absurd (bound is strictly greater-than).
	r := tr.Apply("t|m|bound", true, 1e15)
	if r.Reason != "first-sample-baseline" {
		t.Fatalf("1e15 exactly should pass guard, got %+v", r)
	}
}

func TestGuardAppliesToComputedDelta(t *testing.T) {
	// Documented policy: a guarded input NEVER updates stored state; the last
	// known-good baseline survives so the next valid sample computes against it.
	tr := NewTracker()
	const key = "t|m|delta-guard"

	tr.Apply(key, true, 0) // baseline = 0
	// raw itself is absurd → guard fires before delta computation.
	r := tr.Apply(key, true, 2e15)
	assertGuard(t, r, "guard:absurd")

	// State must still hold 0 (bad sample did not clobber it).
	r = tr.Apply(key, true, 5)
	if !r.Store || r.Value != 5 {
		t.Fatalf("expected delta 5 vs surviving baseline 0, got %+v", r)
	}

	// Also verify a guarded sample mid-stream does not clobber a good baseline.
	tr2 := NewTracker()
	const key2 = "t|m|delta-guard2"
	tr2.Apply(key2, true, 100) // baseline
	tr2.Apply(key2, true, 200) // delta 100, state=200
	assertGuard(t, tr2.Apply(key2, true, math.NaN()), "guard:nan")
	r = tr2.Apply(key2, true, 250)
	if !r.Store || r.Value != 50 {
		t.Fatalf("expected delta 50 vs surviving baseline 200, got %+v", r)
	}
}

func TestConcurrentApply(t *testing.T) {
	tr := NewTracker()
	const goroutines = 16
	const iters = 200

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			key := "t|m|g=" + string(rune('a'+g))
			tr.Apply(key, true, 0) // baseline
			for i := 1; i <= iters; i++ {
				r := tr.Apply(key, true, float64(i*10))
				if !r.Store || r.Value != 10 {
					t.Errorf("concurrent key=%s i=%d: got %+v", key, i, r)
					return
				}
			}
		}(g)
	}
	wg.Wait()
}

package backoff

import (
	"sync"
	"testing"
	"time"
)

func TestNextExponential(t *testing.T) {
	p := DefaultPolicy()
	want := []time.Duration{
		1 * time.Second,  // 1 failure: Base
		2 * time.Second,  // <<1
		4 * time.Second,  // <<2
		8 * time.Second,  // <<3
		16 * time.Second, // <<4
		32 * time.Second, // <<5
		60 * time.Second, // <<6 = 64s exceeds cap -> Cap
	}
	for i, w := range want {
		got := p.Next(i + 1)
		if got != w {
			t.Errorf("Next(%d) = %v, want %v", i+1, got, w)
		}
	}
	if got := p.Next(0); got != 0 {
		t.Errorf("Next(0) = %v, want 0", got)
	}
	if got := p.Next(-3); got != 0 {
		t.Errorf("Next(-3) = %v, want 0", got)
	}
}

func TestNextCapOverflow(t *testing.T) {
	p := DefaultPolicy()
	for _, n := range []int{63, 64, 65, 200, 1_000_000} {
		got := p.Next(n)
		if got != p.Cap {
			t.Errorf("Next(%d) = %v, want cap %v (no overflow/panic/negative)", n, got, p.Cap)
		}
		if got < 0 {
			t.Errorf("Next(%d) = %v is negative", n, got)
		}
	}
}

func TestTrackerReset(t *testing.T) {
	tr := NewTracker(DefaultPolicy())

	for i := 1; i <= 3; i++ {
		if n := tr.RecordFailure("target-a"); n != i {
			t.Fatalf("RecordFailure #%d returned %d, want %d", i, n, i)
		}
	}
	if got := tr.Failures("target-a"); got != 3 {
		t.Errorf("Failures = %d, want 3", got)
	}
	if got := tr.Wait("target-a"); got != 4*time.Second {
		t.Errorf("Wait after 3 failures = %v, want 4s", got)
	}

	tr.RecordSuccess("target-a")
	if got := tr.Failures("target-a"); got != 0 {
		t.Errorf("Failures after success = %d, want 0", got)
	}
	if got := tr.Wait("target-a"); got != 0 {
		t.Errorf("Wait after success = %v, want 0", got)
	}
}

func TestTrackerConcurrent(t *testing.T) {
	tr := NewTracker(DefaultPolicy())
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(key string) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				tr.RecordFailure(key)
				tr.Wait(key)
				tr.Failures(key)
			}
			tr.RecordSuccess(key)
		}(string(rune('a' + i)))
	}
	wg.Wait()
	// All goroutines recorded success last, so every count must be 0.
	for i := 0; i < 8; i++ {
		key := string(rune('a' + i))
		if got := tr.Failures(key); got != 0 {
			t.Errorf("Failures(%q) = %d after success, want 0", key, got)
		}
	}
}

// Package backoff implements per-target exponential backoff for scrape
// failures, with a configurable base delay and cap.
package backoff

import (
	"sync"
	"time"
)

// Policy describes an exponential backoff schedule: the first failure waits
// Base, the second waits Base<<1, and so on, never exceeding Cap.
type Policy struct {
	Base time.Duration
	Cap  time.Duration
}

// DefaultPolicy returns the standard schedule: 1s base, 60s cap.
func DefaultPolicy() Policy {
	return Policy{Base: 1 * time.Second, Cap: 60 * time.Second}
}

// Next returns the wait duration to apply after the given number of
// consecutive failures for a target.
//
//   - consecutiveFailures <= 0 -> 0 (no waiting after a success)
//   - otherwise d = Base << (consecutiveFailures - 1)
//   - overflow/saturation guard: if consecutiveFailures > 63, or d > Cap,
//     or d <= 0 (int64 overflow/wraparound) -> Cap
func (p Policy) Next(consecutiveFailures int) time.Duration {
	if consecutiveFailures <= 0 {
		return 0
	}
	if consecutiveFailures > 63 {
		return p.Cap
	}
	d := p.Base << uint(consecutiveFailures-1)
	if d <= 0 || d > p.Cap {
		return p.Cap
	}
	return d
}

// Tracker records per-key consecutive failure counts and exposes the wait
// duration each key should currently honor. It is safe for concurrent use.
type Tracker struct {
	mu     sync.Mutex
	policy Policy
	fails  map[string]int
}

// NewTracker returns a Tracker using the given policy.
func NewTracker(p Policy) *Tracker {
	return &Tracker{policy: p, fails: make(map[string]int)}
}

// RecordFailure records a failure for key and returns the new consecutive
// failure count.
func (t *Tracker) RecordFailure(key string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.fails[key]++
	return t.fails[key]
}

// RecordSuccess resets the consecutive failure count for key to 0.
func (t *Tracker) RecordSuccess(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.fails[key] = 0
}

// Failures returns the current consecutive failure count for key (0 if none).
func (t *Tracker) Failures(key string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.fails[key]
}

// Wait returns the backoff wait duration for key, derived from the policy
// and the key's current consecutive failure count.
func (t *Tracker) Wait(key string) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.policy.Next(t.fails[key])
}

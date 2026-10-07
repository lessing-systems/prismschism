// Command scraper polls every configured LiteLLM backend's /metrics endpoint,
// parses the exposed Prometheus metrics into typed rows, and writes them to
// PostgreSQL together with per-target scrape-health records.
//
// Write policy (gap semantics): on a scrape failure NO metric rows are
// written (the series simply has a gap); every attempt still writes one health row.
//
// HealthValue: scrape duration in seconds on
// success, 0 on failure.
//
// Security contract: log lines never contain API key values. target and key
// environment variable names are logged freely; key values are not.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"prismschism/scraper/internal/backoff"
	"prismschism/scraper/internal/delta"
	"prismschism/scraper/internal/fetcher"
	"prismschism/scraper/internal/inventory"
	"prismschism/scraper/internal/parser"
	"prismschism/scraper/internal/store"
	"prismschism/scraper/internal/targets"
)

const (
	defaultTargetsPath = "/config/targets.yaml"
	defaultInterval    = 15 * time.Second

	// maxConcurrent is the scrape fan-out limit.
	maxConcurrent = 50

	// statusLimit truncates error text stored in the instance_health.status
	// column.
	statusLimit = 512

	// heartbeatBackend is the backend recorded on the scraper's liveness
	// heartbeat health row, written once per cycle before target fan-out.
	heartbeatBackend = "scraper-tick"

	// statusTick marks the per-cycle scraper liveness heartbeat row.
	statusTick = "tick"

	// statusBackoff marks the health row written when a target scrape is
	// skipped because the target is still inside its backoff window.
	statusBackoff = "backoff"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	targetsPath := envOr("SCRAPER_TARGETS", defaultTargetsPath)
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	interval, err := intervalFromEnv()
	if err != nil {
		log.Fatal(err)
	}

	tlist, err := targets.Load(targetsPath)
	if err != nil {
		log.Fatalf("load targets: %v", err)
	}
	log.Printf("scraper starting: %d target(s), interval %s, targets file %s", len(tlist), interval, targetsPath)

	// Startup ctx with a deadline so a hung ping cannot block startup forever.
	openCtx, cancelOpen := context.WithTimeout(context.Background(), 30*time.Second)
	warehouse, err := store.OpenPostgres(openCtx, dbURL)
	cancelOpen()
	if err != nil {
		log.Fatalf("open postgres: %v", err)
	}

	fetch := fetcher.New(fetcher.DefaultTimeout)
	tripwire := parser.NewTripwire(10)
	tracker := backoff.NewTracker(backoff.DefaultPolicy())
	// The inventory cache backs the parser's model_id -> model_group resolution
	// and must be installed before the first scrape.
	invCache := inventory.NewCache()
	parser.SetGroupLookup(invCache.Resolve)
	invSync := inventory.NewSyncer(fetch, warehouse, invCache, nil)
	// One shared delta tracker for the process lifetime: per-series last-sample
	// state (keyed by SeriesKey) survives across all scrape cycles, so counter
	// deltas are computed correctly cycle-over-cycle. It is created here in the
	// setup path (not inside runCycle) precisely so that state is never
	// re-created between cycles.
	deltaTracker := delta.NewTracker()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	lastAttempt := make(map[string]time.Time, len(tlist)) // per-target backoff state

	runCycle(ctx, tlist, warehouse, fetch, tripwire, tracker, deltaTracker, lastAttempt)
	for _, t := range tlist {
		syncInventory(ctx, t, invSync, tracker)
	}

	for ctx.Err() == nil {
		<-ticker.C
		runCycle(ctx, tlist, warehouse, fetch, tripwire, tracker, deltaTracker, lastAttempt)
		for _, t := range tlist {
			syncInventory(ctx, t, invSync, tracker)
		}
	}

	if err := warehouse.Close(); err != nil {
		log.Printf("close postgres: %v", err)
	}
	log.Printf("scraper stopped: %d target(s)", len(tlist))
}

// runCycle scrapes all targets concurrently, bounded to maxConcurrent
// in-flight scrapes.
//
// The natural fit is golang.org/x/sync/errgroup with eg.SetLimit(50); to keep
// the dependency surface minimal we implement the same semantics with a
// plain sync.WaitGroup plus a counting-semaphore channel of size 50.
func runCycle(ctx context.Context, tlist []targets.Target, w store.Writer, fetch *fetcher.Fetcher, tw *parser.Tripwire, tracker *backoff.Tracker, deltaTracker *delta.Tracker, lastAttempt map[string]time.Time) {
	// Scraper liveness heartbeat: write one "tick" health row before any target
	// fan-out. This is the scraper liveness heartbeat — it guarantees that even
	// a cycle with zero targets (or before any target scrape runs) still leaves
	// a row in instance_health, making zero-target ticks non-starving so the
	// scraper's own liveness stays observable. A write failure is logged and
	// does not stop the cycle.
	if err := w.WriteHealth(ctx, store.HealthRow{
		TS:          time.Now().UTC(),
		Backend:     heartbeatBackend,
		Up:          false,
		Status:      statusTick,
		HealthValue: 0,
	}); err != nil {
		log.Printf("write tick heartbeat health row: %v", err)
	}

	// One goroutine per target. Each goroutine holds the
	// semaphore for its entire scrape+parse+write, so at most maxConcurrent
	// targets are being processed at any moment — errgroup.SetLimit(50)
	// equivalent. The scraper is I/O-bound, so blocking on the semaphore
	// costs almost nothing.
	sem := make(chan struct{}, maxConcurrent)
	var wg sync.WaitGroup
	for _, t := range tlist {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			if ctx.Err() != nil {
				return
			}
			scrapeTarget(ctx, t, w, fetch, tw, tracker, deltaTracker, lastAttempt)
		}()
	}
	wg.Wait()
}

// scrapeTarget runs one scrape cycle for a single target, applying the
// per-target backoff skip and recording success/failure in the tracker.
//
// Backoff: tracker.Wait(name) is the remaining wait derived from the
// consecutive-failure count. If the time since the last attempt is shorter
// than that, this tick's scrape is skipped, but a backoff health row is still
// written so the skipped tick remains observable.
// lastAttempt is updated only when a scrape is actually attempted.
func scrapeTarget(ctx context.Context, t targets.Target, w store.Writer, fetch *fetcher.Fetcher, tw *parser.Tripwire, tracker *backoff.Tracker, deltaTracker *delta.Tracker, lastAttempt map[string]time.Time) {
	// Backoff is decided on the cycle ctx, not the per-scrape ctx, so a mid-cycle shutdown cannot cause an extra skip.
	now := time.Now()
	if last, ok := lastAttempt[t.Name]; ok {
		if wait := tracker.Wait(t.Name); now.Before(last.Add(wait)) {
			// The scrape for this tick is skipped because the target is still
			// inside its backoff window, but a backoff health row is written so
			// the skipped tick remains observable in instance_health.
			log.Printf("target %s: backing off for another %s", t.Name, wait.Round(time.Millisecond))
			if err := w.WriteHealth(ctx, store.HealthRow{
				TS:          time.Now().UTC(),
				Backend:     t.Name,
				Up:          false,
				Status:      statusBackoff,
				HealthValue: 0,
			}); err != nil {
				log.Printf("target %s: write backoff health row: %v", t.Name, err)
			}
			return
		}
	}

	// Per-scrape context with the fetcher's default timeout (5s).
	scrapeCtx, cancel := context.WithTimeout(ctx, fetcher.DefaultTimeout)
	defer cancel()

	lastAttempt[t.Name] = time.Now()

	start := time.Now()
	body, err := fetch.Scrape(scrapeCtx, t.URL, t.APIKey)
	if err != nil {
		recordFailure(ctx, t.Name, w, start, err, tracker)
		return
	}

	result, err := parser.Parse(string(body), time.Now().UTC(), tw)
	if err != nil {
		recordFailure(ctx, t.Name, w, start, err, tracker)
		return
	}
	if result.TripwireTripped {
		// Parser already dropped the excess above the tripwire budget; only the
		// allowed rows remain in result.Rows: no silent ingest.
		log.Printf("target %s: cardinality tripwire tripped at %d series — excess dropped, allowed rows written", t.Name, result.SeriesCount)
	}

	// Apply per-series delta policy before writing:
	// counter series are stored as per-interval deltas (first sample skipped,
	// resets handled by the tracker) and gauge series are stored raw. Rows the
	// tracker rejects are logged (Family + metric name + reason ONLY — the
	// series key and any label value, e.g. hashed_api_key, are never logged).
	kept, skipped := applyDeltas(deltaTracker, result.Rows)
	if skipped > 0 {
		log.Printf("target %s: %d row(s) skipped by delta tracker", t.Name, skipped)
	}
	if len(kept) > 0 {
		// Only real parsed rows are written — zeros are NEVER synthesized.
		if err := w.WriteMetrics(ctx, kept); err != nil {
			recordFailure(ctx, t.Name, w, start, err, tracker)
			return
		}
	}

	// HealthValue = scrape duration in seconds on success, 0 on failure.
	if err := w.WriteHealth(ctx, store.HealthRow{
		TS:          time.Now().UTC(),
		Backend:     t.Name,
		Up:          true,
		Status:      "ok",
		HealthValue: time.Since(start).Seconds(),
	}); err != nil {
		log.Printf("target %s: write health row: %v", t.Name, err)
		return
	}
	tracker.RecordSuccess(t.Name)
}

// syncInventory polls one target's /model/info via the inventory syncer,
// applying the same tracker-based backoff used by scrapeTarget (adapted:
// no lastAttempt map exists here, so a non-zero Wait means still backing off).
func syncInventory(ctx context.Context, t targets.Target, s *inventory.Syncer, tr *backoff.Tracker) {
	key := t.Name + ":modelinfo"
	if d := tr.Wait(key); d > 0 {
		return
	}

	_, err := s.Sync(ctx, t.Name, t.URL, t.APIKey)
	if err != nil {
		// A failed /model/info poll leaves the last-known-good inventory rows
		// and the in-memory cache untouched; it must never abort or affect the
		// metrics scrape loop.
		f := tr.RecordFailure(key)
		log.Printf("target %s: model info sync failed (failure #%d): %v", t.Name, f, err)
		return
	}
	tr.RecordSuccess(key)
	// Success is intentionally not logged: this fires every 15s per target and
	// main.go has no verbose flag; INFO here would flood the log.
}

// applyDeltas routes every parsed row through the shared delta tracker and
// returns the rows that should be stored, with each counter row's Value
// replaced by the tracker's per-interval delta (gauge rows keep their raw
// value). Rows the tracker rejects are skipped and logged — ONE line each —
// carrying ONLY the storage table (Family), the metric name, and the tracker's
// machine-readable reason. The full series key and any label value (e.g.
// hashed_api_key) are deliberately never logged.
func applyDeltas(t *delta.Tracker, rows []parser.Row) (kept []parser.Row, skipped int) {
	for _, r := range rows {
		res := t.Apply(r.SeriesKey(), r.IsCounter, r.Value)
		if !res.Store {
			skipped++
			log.Printf("delta skip: table=%s metric=%s reason=%s", r.Family, r.MetricName, res.Reason)
			continue
		}
		rr := r
		rr.Value = res.Value
		kept = append(kept, rr)
	}
	return kept, skipped
}

// recordFailure applies the gap semantics: on fetch/parse/write failure no metric rows
// are written; a failure health row is still written and the failure recorded.
// fetcher error strings never contain the API key, so logging err is safe.
func recordFailure(ctx context.Context, name string, w store.Writer, start time.Time, cause error, tracker *backoff.Tracker) {
	n := tracker.RecordFailure(name)
	log.Printf("target %s: scrape failed (failure #%d): %v", name, n, cause)

	if err := w.WriteHealth(ctx, store.HealthRow{
		TS:          time.Now().UTC(),
		Backend:     name,
		Up:          false,
		Status:      truncate(cause.Error(), statusLimit),
		HealthValue: 0,
	}); err != nil {
		log.Printf("target %s: write failure health row: %v", name, err)
	}
}

// truncate shortens s to at most n runes.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// envOr returns the value of the environment variable named k, or def if it
// is unset or blank.
func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

// intervalFromEnv reads SCRAPE_INTERVAL as seconds; unset or blank falls back
// to defaultInterval.
func intervalFromEnv() (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv("SCRAPE_INTERVAL"))
	if raw == "" {
		return defaultInterval, nil
	}
	secs, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, fmt.Errorf("SCRAPE_INTERVAL must be a number of seconds, got %q", raw)
	}
	if secs <= 0 {
		return 0, fmt.Errorf("SCRAPE_INTERVAL must be positive, got %s", raw)
	}
	return time.Duration(secs * float64(time.Second)), nil
}

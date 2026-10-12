package store

import (
	"context"
	"reflect"
	"testing"
	"time"

	"prismschism/scraper/internal/inventory"
)

// TestLastSyncedModelIDsSideChannel asserts the pure-Go side channel that
// threads the successful sync's keep set to the prune call site (main.go
// syncInventory -> store.LastSyncedModelIDs):
//
//  1. recordSyncedModelIDs persists the model_id list of a completed upsert,
//     readable via LastSyncedModelIDs.
//  2. An EMPTY catalog is a successful upsert (UpsertDeployments returns nil
//     before touching the db, so a zero-value PG suffices here) and records an
//     EMPTY, non-nil slice — never a stale list from a previous sync that
//     would shield rows that vanished from the roster.
func TestLastSyncedModelIDsSideChannel(t *testing.T) {
	recordSyncedModelIDs([]inventory.Deployment{
		{ModelID: "test-dep-a", ModelGroup: "tools"},
		{ModelID: "test-dep-b", ModelGroup: "tools"},
	})
	got := LastSyncedModelIDs()
	want := []string{"test-dep-a", "test-dep-b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("LastSyncedModelIDs() = %v, want %v", got, want)
	}

	p := &PG{} // empty-catalog upsert returns before any db access
	if err := p.UpsertDeployments(context.Background(), nil); err != nil {
		t.Fatalf("empty-catalog UpsertDeployments: %v", err)
	}
	got = LastSyncedModelIDs()
	if got == nil {
		t.Fatal("LastSyncedModelIDs() = nil after empty-catalog sync, want non-nil empty slice (a stale keep set would shield vanished rows)")
	}
	if len(got) != 0 {
		t.Fatalf("LastSyncedModelIDs() = %v, want empty", got)
	}
}

// TestPruneDeploymentsKeepsLiveRosterAndDropsStaleGhosts is the SQL-level
// guarantee of PruneDeployments, proven against a real Postgres via the same
// throwaway-schema harness as the upsert tests (livePG). It deletes ONLY rows
// that are BOTH absent from the keep set AND quiet past the grace:
//
//	(a) test-dep-ghost:   absent from keep, last_alive 48h old  -> DELETED
//	(b) test-dep-stale:   absent from keep, last_alive 48h old  -> DELETED
//	(c) test-dep-in-keep: in keep, last_alive 72h old          -> KEPT
//	(d) test-dep-recent:  absent from keep, last_alive fresh    -> KEPT
//
// A second prune with a nil keep set (an empty catalog is a valid keep set:
// ALL() over an empty array is vacuously true) removes the remaining quiet
// ghost but still spares the freshly refreshed roster member.
//
//	Run it with:
//	  TEST_DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=disable go test ./internal/store/ -run TestPruneDeployments -v
func TestPruneDeploymentsKeepsLiveRosterAndDropsStaleGhosts(t *testing.T) {
	p := livePG(t)
	ctx := context.Background()

	roster := []inventory.Deployment{
		{ModelID: "test-dep-in-keep", ModelGroup: "tools", APIBase: "http://dep-a.example.test:8001/v1"},
		{ModelID: "test-dep-recent", ModelGroup: "tools", APIBase: "http://dep-b.example.test:8001/v1"},
	}
	if err := p.UpsertDeployments(ctx, roster); err != nil {
		t.Fatalf("seed roster upsert: %v", err)
	}
	// Ghost rows never in any successful sync's catalog: seed directly, then
	// backdate last_alive past the grace (48h > 24h). Synthetic placeholder
	// ids and example.test bases only — never real hosts.
	for _, id := range []string{"test-dep-ghost", "test-dep-stale"} {
		if _, err := p.db.ExecContext(ctx,
			`INSERT INTO deployment_inventory (model_id, model_group, api_base, last_alive)
			 VALUES ($1, 'tools', 'http://ghost.example.test:8000/v1', now() - interval '48 hours')`, id); err != nil {
			t.Fatalf("seed ghost %s: %v", id, err)
		}
	}
	// (c) is in the keep set yet very quiet (72h) — the keep set must protect
	// it regardless of last_alive.
	if _, err := p.db.ExecContext(ctx,
		`UPDATE deployment_inventory SET last_alive = now() - interval '72 hours' WHERE model_id = $1`,
		"test-dep-in-keep"); err != nil {
		t.Fatalf("backdate keep-row last_alive: %v", err)
	}

	keep := []string{"test-dep-in-keep", "test-dep-recent"}
	const grace = 24 * time.Hour
	deleted, err := p.PruneDeployments(ctx, keep, grace)
	if err != nil {
		t.Fatalf("PruneDeployments: %v", err)
	}
	if deleted != 2 {
		t.Errorf("pruned rows = %d, want 2 (both stale ghosts)", deleted)
	}

	var ids []string
	rows, err := p.db.QueryContext(ctx, "SELECT model_id FROM deployment_inventory ORDER BY model_id")
	if err != nil {
		t.Fatalf("read survivors: %v", err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan survivor: %v", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate survivors: %v", err)
	}

	wantSurvivors := []string{"test-dep-in-keep", "test-dep-recent"}
	if !reflect.DeepEqual(ids, wantSurvivors) {
		t.Fatalf("survivors = %v, want %v (ghosts dropped; keep-row kept despite 72h quiet; recent absent row kept)", ids, wantSurvivors)
	}

	// A nil keep set is an empty catalog: every quiet row is prunable, but the
	// freshly refreshed last_alive of test-dep-recent still clears the grace.
	deleted, err = p.PruneDeployments(ctx, nil, grace)
	if err != nil {
		t.Fatalf("nil-keep PruneDeployments: %v", err)
	}
	if deleted != 1 {
		t.Errorf("nil-keep pruned rows = %d, want 1 (the backdated keep-row; the refreshed row survives its grace)", deleted)
	}
	var n int
	if err := p.db.QueryRowContext(ctx, "SELECT count(*) FROM deployment_inventory").Scan(&n); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if n != 1 {
		t.Errorf("rows after nil-keep prune = %d, want 1 (test-dep-recent)", n)
	}
}

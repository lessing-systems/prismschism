package store

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"prismschism/scraper/internal/inventory"
)

// upsertInventorySQL is the single-statement template used to upsert the whole
// deployment catalog in one round-trip. %s is replaced with the generated
// VALUES row list (N tuples of four $k placeholders plus two now() timestamps),
// built with a strings.Builder.
const upsertInventorySQL = `INSERT INTO deployment_inventory (model_id, model_group, api_base, raw_model, first_seen, last_alive)
VALUES %s
ON CONFLICT (model_id) DO UPDATE SET
  model_group = EXCLUDED.model_group,
  api_base = COALESCE(EXCLUDED.api_base, deployment_inventory.api_base),
  raw_model = COALESCE(EXCLUDED.raw_model, deployment_inventory.raw_model),
  last_alive = now()`

// nilIfEmpty maps an absent LiteLLM field to a NULL parameter so the COALESCE
// in upsertInventorySQL can preserve the last-known-good value. A non-empty
// string yields a pointer to a copy of s.
func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// The Syncer (internal/inventory) returns only the deployment count from a
// sync, so the model_id set of each SUCCESSFUL upsert is captured here as a
// side channel: main reads it back with LastSyncedModelIDs after a fully
// successful sync and passes it to PruneDeployments. This threads the sync set
// to the prune call site without widening the Syncer's signature. Guarded by a
// mutex because UpsertDeployments is part of the Upserter interface and could
// in principle be called from more than one goroutine.
var (
	syncedIDsMu sync.Mutex
	syncedIDs   []string
)

// recordSyncedModelIDs stores the model_id list of a completed upsert. Called
// only on success paths — a failed exec leaves the previous value, which is
// unreachable for pruning because the caller prunes only after a fully
// successful sync (whose own upsert has then recorded its set).
func recordSyncedModelIDs(deps []inventory.Deployment) {
	ids := make([]string, len(deps))
	for i, d := range deps {
		ids[i] = d.ModelID
	}
	syncedIDsMu.Lock()
	syncedIDs = ids
	syncedIDsMu.Unlock()
}

// LastSyncedModelIDs returns the model_id list persisted by the most recent
// successful UpsertDeployments call (nil when that upsert carried no
// deployments — an empty catalog is a successful sync whose keep set is
// empty).
func LastSyncedModelIDs() []string {
	syncedIDsMu.Lock()
	defer syncedIDsMu.Unlock()
	return syncedIDs
}

// UpsertDeployments persists a parsed deployment catalog as ONE multi-row
// upsert keyed on model_id. This is an upsert only — it never deletes and never
// nulls last_alive. An api_base or raw_model that LiteLLM omitted arrives as an
// empty Go string and is sent as a NULL parameter (see nilIfEmpty) rather than
// an empty string, so the COALESCE in upsertInventorySQL genuinely preserves the
// previous value instead of wiping it. An empty slice is a no-op (no statement
// is executed).
func (p *PG) UpsertDeployments(ctx context.Context, deps []inventory.Deployment) error {
	if len(deps) == 0 {
		// An empty catalog is still a SUCCESSFUL sync: record the (empty)
		// keep set so a subsequent prune does not consult a stale list and
		// accidentally shield rows that have vanished from the roster.
		recordSyncedModelIDs(deps)
		return nil
	}

	// Build the N-row VALUES list with a strings.Builder, generating the
	// placeholders as $k incrementing (N rows x 4 params) — the same inline
	// style as insertFamily. first_seen and last_alive are now(), not
	// placeholders: on conflict only last_alive is refreshed (see the
	// ON CONFLICT clause), while first_seen survives untouched via the
	// conflict target (model_id).
	var b strings.Builder
	args := make([]any, 0, len(deps)*4)
	placeholders := make([]string, 4)
	for i, d := range deps {
		if i > 0 {
			b.WriteByte(',')
		}
		base := i*4 + 1
		for j := 0; j < 4; j++ {
			placeholders[j] = fmt.Sprintf("$%d", base+j)
		}
		b.WriteByte('(')
		b.WriteString(strings.Join(placeholders, ","))
		b.WriteString(",now(),now())")

		// model_id and model_group are deliberately passed through as plain
		// strings, never nil. model_id is the PRIMARY KEY and the ON CONFLICT
		// target, so a NULL would violate the constraint and there is no
		// COALESCE on it anyway. model_group is NOT NULL in
		// infra/db/migrations/007_deployment_inventory.sql and the upsert
		// intentionally overwrites it (`model_group = EXCLUDED.model_group`, no
		// COALESCE); sending NULL there would raise a NOT NULL violation and
		// turn a benign missing field into a hard scrape failure. Only
		// api_base/raw_model get the NULL treatment, since those are exactly the
		// columns wrapped in COALESCE.
		args = append(args, d.ModelID, d.ModelGroup, nilIfEmpty(d.APIBase), nilIfEmpty(d.RawModel))
	}

	query := fmt.Sprintf(upsertInventorySQL, b.String())
	if _, err := p.db.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("upsert deployments: %w", err)
	}
	// Only a successful exec updates the recorded sync set (see
	// recordSyncedModelIDs).
	recordSyncedModelIDs(deps)
	return nil
}

// pruneInventorySQL deletes roster rows that are absent from the successful
// sync's keep set AND whose last_alive is older than the grace period. $1 is a
// text[] of model_ids, $2 the grace in seconds via make_interval — no values
// are ever interpolated into the statement text.
const pruneInventorySQL = `DELETE FROM deployment_inventory
WHERE model_id <> ALL($1::text[])
  AND last_alive < now() - make_interval(secs => $2::int)`

// PruneDeployments removes deployments that vanished from LiteLLM's roster:
// it deletes only rows absent from keep — the model_id set of a SUCCESSFUL
// inventory sync — AND quiet past the grace (olderThan). Live deployments
// refresh last_alive on every upsert (see UpsertDeployments), so the grace
// only bites long-dead rows; a row still present in a live catalog is
// protected both by its own sync's keep set and by its freshly refreshed
// last_alive. A failed sync never reaches this method (the caller prunes only
// on success), so the last-known-good guarantee of failed /model/info polls
// is preserved. keep may be nil or empty, which is a valid keep set (an
// empty catalog) — ALL() over an empty array is vacuously true, so every
// quiet row is then prunable. Returns the number of rows deleted.
func (p *PG) PruneDeployments(ctx context.Context, keep []string, olderThan time.Duration) (int64, error) {
	if keep == nil {
		keep = []string{}
	}
	res, err := p.db.ExecContext(ctx, pruneInventorySQL, keep, int(olderThan.Seconds()))
	if err != nil {
		return 0, fmt.Errorf("prune deployment_inventory: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("prune deployment_inventory: rows affected: %w", err)
	}
	return n, nil
}

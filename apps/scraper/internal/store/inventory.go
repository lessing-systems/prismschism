package store

import (
	"context"
	"fmt"
	"strings"

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

// UpsertDeployments persists a parsed deployment catalog as ONE multi-row
// upsert keyed on model_id. This is an upsert only — it never deletes and never
// nulls last_alive. An api_base or raw_model that LiteLLM omitted arrives as an
// empty Go string and is sent as a NULL parameter (see nilIfEmpty) rather than
// an empty string, so the COALESCE in upsertInventorySQL genuinely preserves the
// previous value instead of wiping it. An empty slice is a no-op (no statement
// is executed).
func (p *PG) UpsertDeployments(ctx context.Context, deps []inventory.Deployment) error {
	if len(deps) == 0 {
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
	return nil
}

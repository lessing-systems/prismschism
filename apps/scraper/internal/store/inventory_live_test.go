package store

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"prismschism/scraper/internal/inventory"
)

// A3: the deployment_inventory upsert is a LAST-KNOWN-GOOD table. Its guarantee
// lives in SQL (COALESCE on api_base / raw_model, last_alive = now()), so it can
// only be proven against a real Postgres. There is no mock sql.DB in this repo.
//
// The test is therefore gated on TEST_DATABASE_URL and SKIPS when it is absent,
// so `go test ./...` stays green without a database. It runs against an isolated
// throwaway schema and drops it again, so it never touches live inventory rows.
//
//	Run it with:
//	  TEST_DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=disable go test ./internal/store/ -run TestUpsertDeployments -v

const inventoryTestURLEnv = "TEST_DATABASE_URL"

const migration007Path = "../../../../infra/db/migrations/007_deployment_inventory.sql"

func livePG(t *testing.T) *PG {
	t.Helper()

	base := strings.TrimSpace(os.Getenv(inventoryTestURLEnv))
	if base == "" {
		t.Skipf("live Postgres not configured: set %s to run the deployment_inventory "+
			"last-known-good test (it is skipped, not faked, without a database)", inventoryTestURLEnv)
	}

	ddl, err := os.ReadFile(migration007Path)
	if err != nil {
		t.Fatalf("read migration 007: %v", err)
	}

	schema := fmt.Sprintf("inventory_test_%d", time.Now().UnixNano())
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	scoped := base + sep + "search_path=" + schema

	setup, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatalf("open admin connection: %v", err)
	}

	ctx := context.Background()
	if _, err := setup.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		setup.Close()
		t.Fatalf("create throwaway schema: %v", err)
	}

	p, err := OpenPostgres(ctx, scoped)
	if err != nil {
		dropTestSchema(setup, schema)
		setup.Close()
		t.Fatalf("open scoped connection: %v", err)
	}
	t.Cleanup(func() {
		p.Close()
		dropTestSchema(setup, schema)
		setup.Close()
	})

	// Migration 007 ships unqualified DDL, so it must be applied THROUGH the
	// search_path-scoped connection or the table lands in public instead.
	if _, err := p.db.ExecContext(ctx, string(ddl)); err != nil {
		t.Fatalf("apply migration 007 in %s: %v", schema, err)
	}
	return p
}

func dropTestSchema(setup *sql.DB, schema string) {
	if _, err := setup.ExecContext(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
		log.Printf("drop throwaway schema %s: %v", schema, err)
	}
}

func TestUpsertDeploymentsAdvancesLastAliveAndKeepsFirstSeen(t *testing.T) {
	p := livePG(t)
	ctx := context.Background()

	dep := inventory.Deployment{
		ModelID: "mid-alive", ModelGroup: "tools",
		APIBase: "http://a:8001/v1", RawModel: "raw-a",
	}
	if err := p.UpsertDeployments(ctx, []inventory.Deployment{dep}); err != nil {
		t.Fatalf("first UpsertDeployments: %v", err)
	}

	// Backdate last_alive so an advance is unambiguous rather than a tie with now().
	if _, err := p.db.ExecContext(ctx,
		"UPDATE deployment_inventory SET last_alive = now() - interval '1 hour' WHERE model_id = $1",
		"mid-alive"); err != nil {
		t.Fatalf("backdate last_alive: %v", err)
	}

	var firstSeen, lastAlive time.Time
	if err := p.db.QueryRowContext(ctx,
		"SELECT first_seen, last_alive FROM deployment_inventory WHERE model_id = $1",
		"mid-alive").Scan(&firstSeen, &lastAlive); err != nil {
		t.Fatalf("read row: %v", err)
	}

	dep.ModelGroup = "orchestration"
	if err := p.UpsertDeployments(ctx, []inventory.Deployment{dep}); err != nil {
		t.Fatalf("second UpsertDeployments: %v", err)
	}

	var newFirst, newLast time.Time
	var group string
	if err := p.db.QueryRowContext(ctx,
		"SELECT first_seen, last_alive, model_group FROM deployment_inventory WHERE model_id = $1",
		"mid-alive").Scan(&newFirst, &newLast, &group); err != nil {
		t.Fatalf("re-read row: %v", err)
	}

	if !newLast.After(lastAlive) {
		t.Errorf("last_alive did not advance: was %v, now %v", lastAlive, newLast)
	}
	if !newFirst.Equal(firstSeen) {
		t.Errorf("first_seen changed on upsert: was %v, now %v", firstSeen, newFirst)
	}
	if group != "orchestration" {
		t.Errorf("model_group = %q, want it overwritten to orchestration", group)
	}
}

func TestUpsertDeploymentsPreservesKnownGoodWhenIncomingIsEmpty(t *testing.T) {
	p := livePG(t)
	ctx := context.Background()

	known := inventory.Deployment{
		ModelID: "mid-known", ModelGroup: "tools",
		APIBase: "http://good:8001/v1", RawModel: "huggingface/good.gguf",
	}
	if err := p.UpsertDeployments(ctx, []inventory.Deployment{known}); err != nil {
		t.Fatalf("seed upsert: %v", err)
	}

	// LiteLLM answering /model/info WITHOUT api_base / model for a deployment
	// yields empty Go strings (ParseModelInfo reads plain string fields). The
	// last-known-good guarantee says the previously stored values must survive.
	followUp := inventory.Deployment{ModelID: "mid-known", ModelGroup: "tools"}
	if err := p.UpsertDeployments(ctx, []inventory.Deployment{followUp}); err != nil {
		t.Fatalf("follow-up upsert: %v", err)
	}

	var apiBase, rawModel string
	if err := p.db.QueryRowContext(ctx,
		"SELECT api_base, raw_model FROM deployment_inventory WHERE model_id = $1",
		"mid-known").Scan(&apiBase, &rawModel); err != nil {
		t.Fatalf("read row: %v", err)
	}

	if apiBase != known.APIBase {
		t.Errorf("last-known-good api_base lost: got %q, want %q", apiBase, known.APIBase)
	}
	if rawModel != known.RawModel {
		t.Errorf("last-known-good raw_model lost: got %q, want %q", rawModel, known.RawModel)
	}
}

func TestUpsertDeploymentsCoalesceWorksForTrueNull(t *testing.T) {
	p := livePG(t)
	ctx := context.Background()

	// Isolate the SQL from the Go layer: when the stored column really is NULL,
	// a later non-empty value must land, and a later NULL must keep the old one.
	if _, err := p.db.ExecContext(ctx,
		`INSERT INTO deployment_inventory (model_id, model_group, api_base, raw_model)
		 VALUES ($1, 'tools', NULL, NULL)`, "mid-null"); err != nil {
		t.Fatalf("seed null row: %v", err)
	}

	dep := inventory.Deployment{ModelID: "mid-null", ModelGroup: "tools", APIBase: "http://x:1/v1"}
	if err := p.UpsertDeployments(ctx, []inventory.Deployment{dep}); err != nil {
		t.Fatalf("upsert over NULL: %v", err)
	}
	var apiBase sql.NullString
	if err := p.db.QueryRowContext(ctx,
		"SELECT api_base FROM deployment_inventory WHERE model_id = $1", "mid-null").Scan(&apiBase); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if apiBase.String != "http://x:1/v1" {
		t.Errorf("api_base = %q, want the new value to replace NULL", apiBase.String)
	}

	if _, err := p.db.ExecContext(ctx,
		`UPDATE deployment_inventory SET api_base = NULL WHERE model_id = $1`, "mid-null"); err != nil {
		t.Fatalf("null out api_base: %v", err)
	}
	if _, err := p.db.ExecContext(ctx,
		`INSERT INTO deployment_inventory (model_id, model_group, api_base, raw_model)
		 VALUES ($1, 'tools', NULL, NULL)
		 ON CONFLICT (model_id) DO UPDATE SET
		   model_group = EXCLUDED.model_group,
		   api_base = COALESCE(EXCLUDED.api_base, deployment_inventory.api_base),
		   raw_model = COALESCE(EXCLUDED.raw_model, deployment_inventory.raw_model),
		   last_alive = now()`, "mid-null"); err != nil {
		t.Fatalf("raw NULL upsert: %v", err)
	}
	if err := p.db.QueryRowContext(ctx,
		"SELECT api_base FROM deployment_inventory WHERE model_id = $1", "mid-null").Scan(&apiBase); err != nil {
		t.Fatalf("re-read row: %v", err)
	}
	if apiBase.Valid {
		t.Errorf("COALESCE let a NULL overwrite the row: %q", apiBase.String)
	}
}

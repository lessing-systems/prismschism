// Package store writes scraped metric rows and per-target scrape-health rows
// to PostgreSQL.
//
// Security contract: the Family value comes from parsed Prometheus metric
// names, and it is validated against a fixed whitelist before it is
// interpolated into the INSERT statement, so a hostile metric name can never
// inject SQL. No API key value is ever logged or written.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // registers driver name "pgx"

	"prismschism/scraper/internal/parser"
)

// HealthRow is a per-target scrape-health record for the instance_health
// table.
type HealthRow struct {
	TS          time.Time
	Backend     string
	Up          bool
	Status      string
	HealthValue float64
}

// Writer is the persistence interface consumed by the scraper main loop.
//
// store imports parser only for the Row type, so there is no import cycle:
// parser does not import store.
type Writer interface {
	WriteMetrics(ctx context.Context, rows []parser.Row) error
	WriteHealth(ctx context.Context, h HealthRow) error
	Close() error
}

// familyWhitelist is the set of Family values WriteMetrics may insert into.
// It is the only path by which a Family string reaches SQL, so validating it
// here is what prevents SQL injection through the metric name.
var familyWhitelist = map[string]bool{
	"input_tokens":      true,
	"output_tokens":     true,
	"reasoning_tokens":  true,
	"cached_tokens":     true,
	"total_tokens":      true,
	"latency":           true,
	"requests":          true,
	"spend":             true,
	"limits":            true,
	"deployment_health": true,
	"counters":          true,
}

// PG implements Writer on top of database/sql with the pgx driver.
type PG struct {
	db *sql.DB
}

// OpenPostgres opens a handle to the database at url (postgres:// DSN) and
// verifies connectivity with a ping on ctx.
func OpenPostgres(ctx context.Context, url string) (*PG, error) {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &PG{db: db}, nil
}

// WriteMetrics inserts rows grouped by Family: ONE multi-row INSERT per
// family. An empty row slice is a no-op. Rows with a Family outside
// familyWhitelist produce an error and nothing is written.
func (p *PG) WriteMetrics(ctx context.Context, rows []parser.Row) error {
	if len(rows) == 0 {
		return nil
	}

	byFamily := make(map[string][]parser.Row)
	for _, r := range rows {
		if !familyWhitelist[r.Family] {
			return fmt.Errorf("write metrics: unknown family %q (allowed: input_tokens, output_tokens, reasoning_tokens, cached_tokens, total_tokens, latency, requests, spend, limits, deployment_health, counters)", r.Family)
		}
		byFamily[r.Family] = append(byFamily[r.Family], r)
	}

	for family, famRows := range byFamily {
		if err := p.insertFamily(ctx, family, famRows); err != nil {
			return err
		}
	}
	return nil
}

// metricColumns is the shared 10-column layout of the four non-token metric
// families (latency, requests, spend, limits).
var metricColumns = []string{
	"ts", "model", "model_id", "api_provider", "value", "unit",
	"hashed_api_key", "api_key_alias", `"user"`, "team",
}

// tokenColumns is the shared 11-column layout of the five token families
// (input_tokens, output_tokens, reasoning_tokens, cached_tokens,
// total_tokens). It is metricColumns plus a "metric" column — holding the
// ORIGINAL Prometheus metric name (Row.MetricName) — inserted immediately
// after "unit". Carrying the original name is what keeps distinct counters
// within one family from being merged, matching
// infra/db/migrations/005_token_families.sql.
var tokenColumns = []string{
	"ts", "model", "model_id", "api_provider", "value", "unit", "metric",
	"hashed_api_key", "api_key_alias", `"user"`, "team",
}

// tokenValues is the positional extractor shared by all five token families:
// the eleven tokenColumns fields in order, with the original Prometheus metric
// name (Row.MetricName) in the "metric" slot (position 7, immediately after
// unit).
var tokenValues = func(r parser.Row) []any {
	return []any{r.TS, r.Model, r.ModelID, r.APIProvider, r.Value,
		r.Unit, r.MetricName, r.HashedAPIKey, r.APIKeyAlias, r.User, r.Team}
}

// latencyColumns is the latency family's own 11-column layout: metricColumns
// plus a "metric" column — holding the ORIGINAL Prometheus metric name
// (Row.MetricName) — inserted immediately after "unit", mirroring tokenColumns.
//
// WHY latency carries `metric`: the latency hypertable collapses eight distinct
// Prometheus latency metrics into one table. TTFT
// (litellm_llm_api_time_to_first_token_metric) and
// litellm_deployment_latency_per_output_token must be selectable BY PROMETHEUS
// NAME so the API can derive prefill/decode tokens-per-second. Without `metric`
// those two are indistinguishable from the other six latency metrics. This is
// the LOCKED CONTRACT written by infra/db/migrations/006_latency_metric.sql.
var latencyColumns = []string{
	"ts", "model", "model_id", "api_provider", "value", "unit", "metric",
	"hashed_api_key", "api_key_alias", `"user"`, "team",
}

// latencyValues is the positional extractor for the latency family: the eleven
// latencyColumns fields in order, with the original Prometheus metric name
// (Row.MetricName) in the "metric" slot (position 7, immediately after unit),
// mirroring tokenValues.
var latencyValues = func(r parser.Row) []any {
	return []any{r.TS, r.Model, r.ModelID, r.APIProvider, r.Value,
		r.Unit, r.MetricName, r.HashedAPIKey, r.APIKeyAlias, r.User, r.Team}
}

// familySchema binds one family's fixed INSERT column list to the positional
// Row-field extractor that feeds it. Both halves live in the same entry so the
// column order and the argument order cannot drift apart.
type familySchema struct {
	columns []string
	values  func(parser.Row) []any
}

// familyColumns is the authoritative per-family storage schema. Every column
// name here is a fixed compile-time constant, never derived from scraped
// input, which is what makes interpolating the list into the INSERT safe once
// the family has passed the familyWhitelist check in WriteMetrics.
var familyColumns = map[string]familySchema{
	// The five token families share one 11-column layout (tokenColumns) and one
	// extractor (tokenValues). The "metric" column carries the ORIGINAL
	// Prometheus metric name (Row.MetricName), so distinct counters within a
	// family are stored separately and never merged.
	"input_tokens": {
		columns: tokenColumns,
		values:  tokenValues,
	},
	"output_tokens": {
		columns: tokenColumns,
		values:  tokenValues,
	},
	"reasoning_tokens": {
		columns: tokenColumns,
		values:  tokenValues,
	},
	"cached_tokens": {
		columns: tokenColumns,
		values:  tokenValues,
	},
	"total_tokens": {
		columns: tokenColumns,
		values:  tokenValues,
	},
	"latency": {
		columns: latencyColumns,
		values:  latencyValues,
	},
	"requests": {
		columns: metricColumns,
		values: func(r parser.Row) []any {
			return []any{r.TS, r.Model, r.ModelID, r.APIProvider, r.Value,
				r.Unit, r.HashedAPIKey, r.APIKeyAlias, r.User, r.Team}
		},
	},
	"spend": {
		columns: metricColumns,
		values: func(r parser.Row) []any {
			return []any{r.TS, r.Model, r.ModelID, r.APIProvider, r.Value,
				r.Unit, r.HashedAPIKey, r.APIKeyAlias, r.User, r.Team}
		},
	},
	"limits": {
		columns: metricColumns,
		values: func(r parser.Row) []any {
			return []any{r.TS, r.Model, r.ModelID, r.APIProvider, r.Value,
				r.Unit, r.HashedAPIKey, r.APIKeyAlias, r.User, r.Team}
		},
	},
	// deployment_health: dedicated health table for the
	// litellm_deployment_state gauge, composite-keyed by
	// (model_id, litellm_model_name). There is no value/unit column: the
	// gauge's numeric 0/1/2 is normalised to a status string by the parser.
	"deployment_health": {
		columns: []string{"ts", "model_id", "litellm_model_name", "status"},
		values: func(r parser.Row) []any {
			return []any{r.TS, r.ModelID, r.LitellmModelName, r.Status}
		},
	},
	// counters: generic event-counter family (e.g.
	// litellm_deployment_cooled_down_total). exception_status is the
	// differentiating label; value/unit carry the per-interval counter delta.
	"counters": {
		columns: []string{"ts", "model_id", "exception_status", "value", "unit"},
		values: func(r parser.Row) []any {
			return []any{r.TS, r.ModelID, r.ExceptionStatus, r.Value, r.Unit}
		},
	},
}

// insertFamily builds and executes ONE multi-row INSERT for one family, using
// that family's column list from familyColumns:
//
//	INSERT INTO <family> (<cols...>) VALUES ($1..$n),($n+1..2n),...
//
// Both the table name and every column name are fixed constants reached only
// after the familyWhitelist validation in WriteMetrics, which is what makes
// interpolating them into the statement safe. The placeholder count follows
// the family's column count, so families with different shapes share this one
// code path while keeping multi-row VALUES batching.
func (p *PG) insertFamily(ctx context.Context, family string, rows []parser.Row) error {
	schema, ok := familyColumns[family]
	if !ok {
		return fmt.Errorf("insert into %s: no column schema for family", family)
	}
	n := len(schema.columns)
	if n == 0 {
		return fmt.Errorf("insert into %s: empty column schema", family)
	}

	var b strings.Builder
	b.WriteString("INSERT INTO ")
	b.WriteString(family)
	b.WriteString(" (")
	b.WriteString(strings.Join(schema.columns, ", "))
	b.WriteString(") VALUES ")

	args := make([]any, 0, len(rows)*n)
	placeholders := make([]string, n)
	for i, r := range rows {
		if i > 0 {
			b.WriteByte(',')
		}
		base := i*n + 1
		for j := range schema.columns {
			placeholders[j] = fmt.Sprintf("$%d", base+j)
		}
		b.WriteByte('(')
		b.WriteString(strings.Join(placeholders, ","))
		b.WriteByte(')')

		vals := schema.values(r)
		if len(vals) != n {
			return fmt.Errorf("insert into %s: %d values for %d columns", family, len(vals), n)
		}
		args = append(args, vals...)
	}

	if _, err := p.db.ExecContext(ctx, b.String(), args...); err != nil {
		return fmt.Errorf("insert into %s: %w", family, err)
	}
	return nil
}

// WriteHealth inserts a per-target scrape-health record. model_id is NULL by
// design: health is per backend/target, not per model.
func (p *PG) WriteHealth(ctx context.Context, h HealthRow) error {
	const query = `INSERT INTO instance_health (ts, backend, model_id, up, status, scraper_health_value) VALUES ($1, $2, NULL, $3, $4, $5)`
	if _, err := p.db.ExecContext(ctx, query, h.TS, h.Backend, h.Up, h.Status, h.HealthValue); err != nil {
		return fmt.Errorf("insert instance_health for target %q: %w", h.Backend, err)
	}
	return nil
}

// Close closes the underlying database connection.
func (p *PG) Close() error {
	return p.db.Close()
}

// Fake implements Writer for tests. It records every call and returns Err
// (if set) from each method. Safe for concurrent use.
type Fake struct {
	mu      sync.Mutex
	Metrics []parser.Row
	Health  []HealthRow
	Err     error
}

// WriteMetrics records the rows and returns f.Err if set.
func (f *Fake) WriteMetrics(_ context.Context, rows []parser.Row) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return f.Err
	}
	f.Metrics = append(f.Metrics, rows...)
	return nil
}

// WriteHealth records the health row and returns f.Err if set.
func (f *Fake) WriteHealth(_ context.Context, h HealthRow) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return f.Err
	}
	f.Health = append(f.Health, h)
	return nil
}

// Close returns f.Err if set.
func (f *Fake) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Err
}

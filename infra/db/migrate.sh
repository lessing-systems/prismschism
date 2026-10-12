#!/bin/sh
#
# migrate.sh - Ledgered, atomic schema migrations for the prismschism
# Postgres/TimescaleDB.
#
# Runs inside the same timescale/timescaledb image as the `db` service (it has
# psql), as the one-shot `db-migrate` compose service. It is the single path by
# which schema is applied: the db service no longer mounts
# ./infra/db/migrations into /docker-entrypoint-initdb.d, because initdb only
# ever runs on an empty volume and silently skips existing deployments.
#
# What it does, in order:
#   1. Waits for the database to accept connections (pg_isready, 60 s cap).
#   2. Creates the ledger table `prismschism_migrations` if missing.
#   3. Auto-baselines pre-migrator deployments: if `public.requests` already
#      exists and the ledger is empty, 000-008 are recorded as applied (they are
#      already present in those databases) so only 009+ are executed.
#   4. Applies every infra/db/migrations/*.sql not yet in the ledger, in sorted
#      order, each in its own single transaction (`psql -1`). A failing file
#      rolls back completely, is NOT recorded, and stops the run: the database
#      is never left half-applied. Re-run after fixing the file.
#
# Usage (inside the container):
#   sh /migrate.sh
#
# Usage (from the repo, against the running db service):
#   docker compose run --rm db-migrate
#
# Environment variables (all optional, defaults shown):
#   DB_HOST             Database host                     (default: db)
#   DB_PORT             Database port                     (default: 5432)
#   POSTGRES_USER       Database user                     (default: litellm)
#   POSTGRES_PASSWORD   Database password                 (default: empty)
#   POSTGRES_DB         Database name                     (default: litellm)
#   MIGRATIONS_DIR      Directory holding *.sql files     (default: /migrations)
#
# Exit codes:
#   0  All migrations applied (or already up to date)
#   1  Configuration/connection failure, or a migration failed and rolled back

set -eu

DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-litellm}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
POSTGRES_DB="${POSTGRES_DB:-litellm}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

LEDGER="prismschism_migrations"
WAIT_ATTEMPTS=60

export PGPASSWORD="$POSTGRES_PASSWORD"

log() {
    printf '[migrate] %s\n' "$*"
}

psql_query() {
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -Atq -v ON_ERROR_STOP=1 -c "$1"
}

# --- 1. Wait for the database -------------------------------------------------
# depends_on db: service_healthy already covers this; belt-and-braces for manual
# runs where the db container may still be starting.

log "Waiting for database $POSTGRES_DB on $DB_HOST:$DB_PORT ..."
ready=0
attempt=1
while [ "$attempt" -le "$WAIT_ATTEMPTS" ]; do
    if pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 1
    attempt=$((attempt + 1))
done

if [ "$ready" -ne 1 ]; then
    log "ERROR: database $DB_HOST:$DB_PORT not accepting connections after ${WAIT_ATTEMPTS}s."
    log "       Start it first: docker compose up -d db"
    exit 1
fi
log "Database is accepting connections."

# --- 2. Ensure the ledger exists ----------------------------------------------

psql_query "CREATE TABLE IF NOT EXISTS $LEDGER (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);"
log "Ledger table $LEDGER ready."

# --- 3. Auto-baseline pre-migrator deployments --------------------------------
# Deployments created before this migrator existed already have everything
# through 008 applied (they came from /docker-entrypoint-initdb.d on a fresh
# volume); only 009+ apply. 000 is included because the timescaledb extension
# already exists per-database on such deployments: leaving 000 pending would
# make CREATE EXTENSION fail and roll back, blocking the scraper.

has_requests="$(psql_query "SELECT to_regclass('public.requests') IS NOT NULL;")"
ledger_count="$(psql_query "SELECT count(*) FROM $LEDGER;")"

if [ "$has_requests" = "t" ] && [ "$ledger_count" = "0" ]; then
    log "Auto-baseline: existing database detected (public.requests present, ledger empty)."
    log "Auto-baseline: recording 000-008 as already applied; only 009+ will run."
    psql_query "INSERT INTO $LEDGER (filename) VALUES
        ('000_create_timescaledb.sql'),
        ('001_schema.sql'),
        ('002_hypertables_compression_retention.sql'),
        ('003_continuous_aggregates.sql'),
        ('004_deployment_health_counters.sql'),
        ('005_token_families.sql'),
        ('006_latency_metric.sql'),
        ('007_deployment_inventory.sql'),
        ('008_ttft_classification.sql')
    ON CONFLICT (filename) DO NOTHING;"
    log "Auto-baseline: ledger seeded with 9 pre-migrator files."
else
    log "Auto-baseline: skipped (public.requests present: $has_requests, ledger rows: $ledger_count)."
fi

# --- 4. Apply pending migrations ----------------------------------------------

if [ ! -d "$MIGRATIONS_DIR" ]; then
    log "ERROR: MIGRATIONS_DIR '$MIGRATIONS_DIR' is not a directory."
    exit 1
fi

applied=0
skipped=0
failed=0

for file in "$MIGRATIONS_DIR"/*.sql; do
    [ -f "$file" ] || continue
    base="$(basename "$file")"

    if [ "$(psql_query "SELECT 1 FROM $LEDGER WHERE filename = '$base';")" = "1" ]; then
        skipped=$((skipped + 1))
        continue
    fi

    log "Applying $base ..."
    if psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -1 -v ON_ERROR_STOP=1 -f "$file"; then
        psql_query "INSERT INTO $LEDGER (filename) VALUES ('$base') ON CONFLICT (filename) DO NOTHING;"
        applied=$((applied + 1))
        log "Applied $base (committed, recorded in ledger)."
    else
        failed=$((failed + 1))
        log ""
        log "MIGRATION FAILED: $base — database unchanged (transaction rolled back)."
        log "MIGRATION FAILED: Fix and re-run 'docker compose up db-migrate'."
        log ""
        log "Applied this run: $applied, skipped (already in ledger): $skipped, failed: $failed."
        exit 1
    fi
done

# --- 5. Summary ----------------------------------------------------------------

log "Done. Applied this run: $applied. Skipped (already in ledger): $skipped."

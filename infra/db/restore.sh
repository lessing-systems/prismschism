#!/usr/bin/env bash
#
# restore.sh - Restore a pg_dump file into the prismschism Postgres/TimescaleDB.
#
# Streams a .sql or .sql.gz dump into the `db` service
# (timescale/timescaledb:2.30.1-pg16) via `docker exec -i ... psql`.
# The dump is expected to contain --clean --if-exists statements (as produced
# by the sibling backup.sh), so existing objects are dropped before restore.
#
# Usage:
#   ./restore.sh [OPTIONS] DUMP_FILE
#
# Arguments:
#   DUMP_FILE   Path to a .sql or .sql.gz dump file (required).
#
# Options:
#   -y, --yes   Skip the interactive confirmation prompt.
#   -h, --help  Show this help.
#
# Environment variables (all optional, defaults shown):
#   CONTAINER   Docker container name   (default: prismschism-db)
#   DB_NAME     Database name         (default: litellm)
#   DB_USER     Database user         (default: litellm)
#
# Examples:
#   ./restore.sh /var/backups/prismschism/db/litellm_20260929_010203.sql.gz
#   ./restore.sh --yes dump.sql
#   CONTAINER=other-db ./restore.sh -y dump.sql.gz
#
# Exit codes:
#   0  Restore completed
#   1  Usage/validation error, container not running, or confirmation declined
#   2  psql restore failed

set -euo pipefail

CONTAINER="${CONTAINER:-prismschism-db}"
DB_NAME="${DB_NAME:-litellm}"
DB_USER="${DB_USER:-litellm}"

ASSUME_YES=0
DUMP_FILE=""

log() {
    printf '[%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >&2
}

usage() {
    sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//' >&2
}

# --- Parse arguments ---------------------------------------------------------

while (( $# > 0 )); do
    case "$1" in
        -y|--yes)
            ASSUME_YES=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            log "ERROR: Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            if [[ -n "$DUMP_FILE" ]]; then
                log "ERROR: Only one DUMP_FILE may be given (extra: $1)."
                exit 1
            fi
            DUMP_FILE="$1"
            shift
            ;;
    esac
done

if [[ -z "$DUMP_FILE" ]]; then
    log "ERROR: DUMP_FILE is required."
    usage
    exit 1
fi

if [[ ! -f "$DUMP_FILE" ]]; then
    log "ERROR: Dump file not found or not a regular file: $DUMP_FILE"
    exit 1
fi

case "$DUMP_FILE" in
    *.sql.gz|*.sql.gzip|*.gz)
        COMPRESSED=1
        ;;
    *.sql)
        COMPRESSED=0
        ;;
    *)
        log "ERROR: Unrecognized dump extension (expected .sql or .sql.gz): $DUMP_FILE"
        exit 1
        ;;
esac

# --- Verify container is running ----------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
    log "ERROR: docker command not found on PATH."
    exit 1
fi

RUNNING="$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
if [[ "$RUNNING" != "true" ]]; then
    log "ERROR: Container '$CONTAINER' is not running (found: '${RUNNING:-not found}')."
    log "       Start it first, e.g.: docker start $CONTAINER"
    exit 1
fi

# --- Confirmation ------------------------------------------------------------

log "About to RESTORE database, overwriting existing data:"
log "  Container : $CONTAINER"
log "  Database  : $DB_NAME (user: $DB_USER)"
log "  Dump file : $DUMP_FILE"

if (( ASSUME_YES != 1 )); then
    if [[ ! -t 0 ]]; then
        log "ERROR: Non-interactive shell detected. Refusing to restore without --yes."
        exit 1
    fi
    printf 'Type "yes" to proceed with the restore: ' >&2
    read -r REPLY
    if [[ "$REPLY" != "yes" ]]; then
        log "Restore cancelled by operator."
        exit 1
    fi
else
    log "Confirmation skipped (--yes)."
fi

# --- Restore -------------------------------------------------------------------

log "Streaming dump into $CONTAINER (psql -U $DB_USER -d $DB_NAME) ..."

set +e
if (( COMPRESSED == 1 )); then
    gunzip -c -- "$DUMP_FILE" \
        | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME"
else
    docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$DUMP_FILE"
fi
status=${PIPESTATUS[1]}
set -e

if (( status != 0 )); then
    log "ERROR: Restore failed (psql exit=$status). Database may be in a partial state."
    exit 2
fi

log "Restore completed successfully: $DUMP_FILE -> $CONTAINER/$DB_NAME"

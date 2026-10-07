#!/usr/bin/env bash
#
# backup.sh - Compressed pg_dump backup for the prismschism Postgres/TimescaleDB.
#
# Dumps the `db` service (timescale/timescaledb:2.30.1-pg16) via `docker exec`
# against the running container, writes a timestamped .sql.gz atomically into
# BACKUP_DIR, then prunes dumps older than RETENTION_DAYS.
#
# Usage:
#   ./backup.sh
#
# Environment variables (all optional, defaults shown):
#   BACKUP_DIR            Target directory for dumps      (default: /var/backups/prismschism/db)
#   CONTAINER             Docker container name           (default: prismschism-db)
#   DB_NAME               Database name                   (default: litellm)
#   DB_USER               Database user                   (default: litellm)
#   RETENTION_DAYS        Days of dumps to keep           (default: 7)
#
# Examples:
#   ./backup.sh
#   BACKUP_DIR=/tmp/dbdumps RETENTION_DAYS=14 ./backup.sh
#   CONTAINER=my-db DB_NAME=app DB_USER=app ./backup.sh
#
# Exit codes:
#   0  Backup completed and retention applied
#   1  Configuration/environment error (bad BACKUP_DIR, container not running)
#   2  Dump or compression failure (temp file cleaned up)

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/prismschism/db}"
CONTAINER="${CONTAINER:-prismschism-db}"
DB_NAME="${DB_NAME:-litellm}"
DB_USER="${DB_USER:-litellm}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

log() {
    printf '[%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >&2
}

TMP_FILE=""

cleanup() {
    if [[ -n "$TMP_FILE" && -e "$TMP_FILE" ]]; then
        log "Cleaning up temp file: $TMP_FILE"
        rm -f "$TMP_FILE"
    fi
}
trap cleanup EXIT

# --- Validate configuration -------------------------------------------------

if [[ -z "${BACKUP_DIR// /}" || "$BACKUP_DIR" == "/" ]]; then
    log "ERROR: BACKUP_DIR is empty or '/'; refusing to run. Set BACKUP_DIR to a dedicated directory."
    exit 1
fi

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || (( RETENTION_DAYS < 1 )); then
    log "ERROR: RETENTION_DAYS must be a positive integer (got: '$RETENTION_DAYS')."
    exit 1
fi

# --- Verify container is running ---------------------------------------------

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

# --- Prepare directories and filenames ---------------------------------------

if ! mkdir -p "$BACKUP_DIR"; then
    log "ERROR: Could not create BACKUP_DIR: $BACKUP_DIR"
    exit 1
fi

TIMESTAMP="$(date -u +"%Y%m%d_%H%M%S")"
BACKUP_FILE="${BACKUP_DIR}/litellm_${TIMESTAMP}.sql.gz"
TMP_FILE="$(mktemp "${BACKUP_DIR}/.litellm_${TIMESTAMP}.sql.gz.XXXXXX")"

# --- Dump --------------------------------------------------------------------

log "Starting backup: container=$CONTAINER db=$DB_NAME user=$DB_USER"
log "Writing dump to temp file: $TMP_FILE"

set +e
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --clean --if-exists \
    | gzip -c > "$TMP_FILE"
pipe_status=("${PIPESTATUS[@]}")
dump_status=${pipe_status[0]}
gzip_status=${pipe_status[1]}
set -e

if (( dump_status != 0 || gzip_status != 0 )); then
    log "ERROR: pg_dump failed (pg_dump=$dump_status, gzip=$gzip_status). Temp file removed; no backup written."
    exit 2
fi

if [[ ! -s "$TMP_FILE" ]]; then
    log "ERROR: Dump produced an empty file; aborting."
    exit 2
fi

# --- Atomic publish ----------------------------------------------------------

mv "$TMP_FILE" "$BACKUP_FILE"
trap - EXIT
TMP_FILE=""

SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
log "Backup written: $BACKUP_FILE ($SIZE)"

# --- Retention ---------------------------------------------------------------

PRUNE_EXPR=(-mtime +"$((RETENTION_DAYS - 1))")
EXPIRED_COUNT="$(find "$BACKUP_DIR" -maxdepth 1 -name 'litellm_*.sql.gz' -type f "${PRUNE_EXPR[@]}" | wc -l)"

if (( EXPIRED_COUNT > 0 )); then
    find "$BACKUP_DIR" -maxdepth 1 -name 'litellm_*.sql.gz' -type f "${PRUNE_EXPR[@]}" -delete
    log "Retention: removed $EXPIRED_COUNT dump(s) older than $RETENTION_DAYS day(s)."
else
    log "Retention: no dumps older than $RETENTION_DAYS day(s) to remove."
fi

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -name 'litellm_*.sql.gz' -type f | wc -l)"
log "Backup complete. $REMAINING dump(s) retained in $BACKUP_DIR."

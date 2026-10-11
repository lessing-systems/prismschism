# AGENTS.md

## This repository is PUBLIC

Everything committed here is permanently visible to anyone. Treat your diff as published before every commit.

### Never commit
- Personal identity: usernames, handles, real names, email addresses.
- Machine or user paths: `/home/<user>/...`, `/Users/<user>/...`, `C:\Users\...`.
- Hostnames, LAN/internal IPs, MAC addresses, internal service URLs, deployment directory names.
- Credentials: API keys, tokens, master keys, passwords, private keys — including "example" values that resemble real ones.
- Production data: user ids, team names, request payloads, verbatim logs or stack traces.

### Use instead
- Placeholders in code, fixtures, and docs: `example.com`, `192.0.2.0/24` (TEST-NET-1), `user@example.com`, `<DEPLOY_DIR>`, `key-a`, `dep-glm`.
- Synthetic fixtures that keep the real data's shape without its values.
- Real endpoints, credentials, and paths belong only in the deployment environment (untracked `.env`, the run directory) — never in the repo.

### If something real already landed
Stop and tell the repo owner immediately. A follow-up commit does not remove it from git history; the history may need rewriting.

---

### The ghost-filter trap (read before adding any grouping or slice)

Any new aggregation that groups or slices by `model_id` (or raw label sets) MUST resolve through `deployment_inventory` the way the existing fleet views do:
- Drop series with no `deployment_inventory` row ("metric-only" ghosts) and inventory rows without `api_base`.
- Never surface raw deployment names as front-end groups, and never bucket unresolved rows as "None"/"Other" — that resurrects the phantom-group bug.
- Reference implementations: `apps/scraper/internal/parser/group.go:69-91` (backend identity vs front-end group), `buildTtftClassifierSql` in `apps/api/src/server.ts` (ghost_reason logic), `FleetMetricsPanel.tsx:111-113` (fleet sums drop `in_inventory === false` points).
- If your slice renders "None" or "Other" buckets, you reintroduced the bug: fix the slice, not the label.

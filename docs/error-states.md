# Error states: what they mean and how we handle them

This page is for the person on call. It explains every error signal this dashboard
produces, where it shows up, and what to do about it. Golden rule: the **Model-Groups
view shows present state**; the **Errors tab shows history** (latest first, last 24h).
If the two disagree, the Errors tab is the record — the cards only ever reflect the
latest health row per deployment.

## Where errors surface

| Signal | Where you see it |
| --- | --- |
| Current deployment health | Card badges (traffic light) in Model-Groups |
| Error history (500s, episodes, lane saturation, scrape gaps) | **Errors tab**, latest on top |
| Live lane pressure on the inference backend | In-flight card (`+N waiting`) |
| Scraper's own connectivity | Errors tab, "Metrics scrape failed" rows |

There is **no alerting** — someone has to look. The Errors tab is the closest thing to
a log; query the DB (table names below) for anything older than 24h.

## The four error kinds (Errors tab)

### Upstream 500 — `cooldown`
**What happened:** while LiteLLM was routing a request, the upstream returned an HTTP
5xx; LiteLLM put that deployment on cooldown and stopped sending traffic for a while.
**Why decode drops to 0 during it:** cooled deployments receive no traffic, so nothing
generates. That is a symptom of the cooldown, not a separate fault.
**What to do:** one-off → ignore. Recurring under load → the upstream's capacity is too
small: check its lane count (`--parallel`) and KV-cache headroom, and read the upstream's
own log at the timestamps for the actual error body (our metrics only carry status codes).
**Stored in:** `counters` (`litellm_deployment_cooled_down_total` deltas, `exception_status`).

### Deployment unhealthy — `state-error`
**What happened:** LiteLLM reported the deployment's state as non-healthy for a run of
scrape ticks. **Stored in:** `deployment_health`.
**What to do:** check the upstream process and its logs in the episode window. If the
badge is red while the Errors tab shows nothing new, trust the Errors tab.

### Lanes saturated — `lane-wait`
**What happened:** every decode lane on the inference backend was busy, so new requests
queued. **What to do:** sustained waiting means the server's parallel capacity is too
small for the traffic — raise it (if memory allows) or add a second replica. A brief
spike during a burst is normal. **Stored in:** `backend_lanes` (metric `waiting`).

### Metrics scrape failed — `scrape-fail`
**What happened:** our scraper could not fetch a target's metrics endpoint.
**Important:** this is a monitoring gap, not proof that the service is down — the
service may have been perfectly fine while our view was dark. **What to do:** check
connectivity to the target; after any restart of the metrics source, expect a short
gap while counters re-baseline (the first tick after a restart is discarded by design).
**Stored in:** `instance_health` (`up = false`). The raw error text is deliberately
never displayed anywhere (it contains target hostnames); it stays in the DB for debugging.

## Health-state mapping (scraper → badge)

| LiteLLM state value | Stored status | Badge | Meaning |
| --- | --- | --- | --- |
| 0 | `healthy` | green (Streaming/Idle) | serving normally |
| 1 — partial outage | `prefill` | amber ("Prefill (approx)") | degraded but serving |
| 2 — maintenance | `prefill` | amber | planned downtime, treated as degraded |
| anything else | `error` | red (Error) | not serving |

Two deliberate rules live behind this table:
1. **Latest row wins per deployment.** LiteLLM has changed the label spelling of its
   health gauge before, which used to pin a stale `error` forever; the dashboard now
   only trusts the newest row. Consequence: the graph does not keep historical outage
   windows red — use the Errors tab for history.
2. **Known limitation:** if a hard outage reports state 1, the badge reads amber
   "Prefill (approx)", not red. The Errors tab's "Upstream 500" rows are the source of
   truth in that case.

## Ghost filtering (why some deployments never appear)

Series with no row in `deployment_inventory` ("metric-only" ghosts) and inventory rows
without an endpoint are excluded from groupings, sums, and cards — including literal
`None`/empty model ids. Deployments removed from LiteLLM are pruned from the roster on
the next successful inventory sync after a 24h grace. If a card shows a flat zero
forever, that is a rostered-but-dead deployment; it disappears within ~24h of the sync
seeing it gone.

## Signals that exist but never render (by design)

- `instance_health.status` text — contains target hostnames; DB-only.
- Cardinality tripwire drops (excess series beyond the cap) — scraper log only.
- Delta-guard skips (`guard:inf`, `guard:absurd`, `guard:negative`) — scraper log only;
  a first-tick baseline after any restart is normal, not an error.

## Alerting

None today. Recommended first alerts: `waiting > 0` sustained on any backend, any new
`cooldown` event, and any `scrape-fail` streak longer than 2 minutes.

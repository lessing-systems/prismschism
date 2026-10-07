<h1 align="center">Prismschism</h1>
<p align="center">A live dashboard for your self-hosted <a href="https://github.com/BerriAI/litellm">LiteLLM</a> fleet: throughput, decode speed, request rates and backend health, per model and per deployment.</p>

<p align="center">
  <img src="docs/screenshot.png" alt="Prismschism dashboard showing combined token/s, per-model request charts and decode speed" width="100%">
</p>

## Run it

You need Docker with Compose, and a LiteLLM proxy with its Prometheus metrics turned on (`litellm_settings: callbacks: ["prometheus"]` in your LiteLLM config).

**Just want to look around first?** No LiteLLM needed, this starts the UI with generated demo data:

```bash
git clone https://github.com/lessing-systems/prismschism.git && cd prismschism
MOCK_API=true docker compose up --build web
```

Then open <http://localhost:5173>.

### 1. Add your LiteLLM secrets

```bash
cp .env.example .env
```

Open `.env` and set:

| Variable | What to put there |
| --- | --- |
| `LITELLM_MASTER_KEY` | Your LiteLLM proxy key. Prismschism uses it to read `/metrics` and the deployment list (`/model/info`). It is only ever read from the environment, never stored in the repo. |
| `POSTGRES_PASSWORD` | Any password for the bundled database. Change it from the default. |

`.env` is git-ignored.

### 2. Point it at your proxy

Edit `config/targets.yaml` and set `url` to your proxy's metrics endpoint:

```yaml
backends:
  - name: primary
    url: http://your-litellm-host:4000/metrics/
    key_env: LITELLM_MASTER_KEY
```

You can list several proxies. Give each its own `name` and, if it uses a different key, its own `key_env` (and add that variable to `.env`).

### 3. Start it

```bash
docker compose up -d --build
```

Open <http://localhost:5173>. Data starts appearing after the first scrape (about 15 seconds); charts fill in as history accumulates.

### 4. Adjust docker-compose.yml (optional)

Everything below is in `docker-compose.yml` or `.env`:

- **Web port:** change `"5173:5173"` under `web.ports` to expose the dashboard on a different port.
- **Database access:** TimescaleDB is published on `127.0.0.1:5432` only. Remove the `ports` entry under `db` if you don't need host access.
- **Scrape-down threshold:** `SCRAPE_DOWN_AFTER_MS` (default 30000) is how long without a successful scrape before the dashboard shows the fleet as down.
- **Hide the "unassigned" card:** set `VITE_DEBUG=0` on the `web` service.
- **Cards per section:** `VITE_TOP_N` (max 20).
- **Tab icon:** set `FAVICON=` to your own icon URL or a file in `apps/web/public`, or `FAVICON=NONE` for no icon.
- **Remove the lessing.systems logo:** the header shows a small "by lessing.systems" credit. Set `SHOW_CREDIT=false` in `.env` (and `docker compose up -d` again) to hide it.

## More

**What you get**

- Combined token/s across the fleet, the peak single-bucket decode rate, and the highest combined rate seen in the last 7 days.
- Per front-end model: requests, average decode t/s, input t/s, requests per minute, and a live state (streaming, prefill, idle, error).
- Per back-end deployment: decode and input token rates, plus deployments that exist in LiteLLM but are idle.
- Errors by provider, with a banner when the scraper loses contact with your proxy.
- 1h / 24h / 7d ranges, five colour schemes, light and dark.

**How it works**

```
LiteLLM /metrics ──► scraper (Go) ──► TimescaleDB ──► API (Node) ──► web (React)
```

The scraper polls your proxy every ~15 seconds and stores counter deltas. The API derives rates at query time. LiteLLM's own internal health-check traffic is dropped so it doesn't show up as phantom models.

**Notes on the numbers**

- *Decode t/s* is output tokens over time spent decoding (upstream latency minus time to first token), so it is a per-stream speed, not wall-clock throughput. Non-streaming calls bias it slightly low.
- *Input t/s* is an input-token rate. It is not true prefill throughput.
- *Combined token/s (observed)* is measured throughput summed over deployments, not a rated maximum.
- Retention: raw data 7 days, 1-minute rollups 30 days, 5-minute and 1-hour rollups 90 days.

**Backups:** `infra/db/backup.sh` and `infra/db/restore.sh` dump and restore the database.

**Development**

```bash
cd apps/web     && npm ci && npm test      # React / Vite
cd apps/api     && npm ci && npm test      # Node API
cd apps/scraper && go test ./...           # Go scraper
```

The compose setup runs the web app with the Vite dev server, which is fine for a private dashboard. Put it behind a reverse proxy with authentication before exposing it beyond your network, since the dashboard itself has no login.

## License

[MIT](LICENSE)

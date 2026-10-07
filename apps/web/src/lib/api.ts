// Fetch-only JSON API client. No SSE here. No query-string library.
import type { Breakdown, Kpi, Metric, MetricPoint, Range } from "./types";

const BASE = "/api";

// ── Scrape-status side-channel ──────────────────────────────────────────────
// The API reports scrape health on RESPONSE HEADERS only (X-Scrape-Last-Success,
// X-Scrape-Down, X-Scrape-Staleness-Ms). Every fetch here goes to the same-origin
// "/api" base — the Vite dev proxy forwards /api -> http://api:8080 — so CORS
// never applies and these headers are readable WITHOUT the API setting
// Access-Control-Expose-Headers. The latest values are parked here so the panel
// can say how stale the scrape is without an extra request per poll.
export interface ScrapeStatus {
  down: boolean;
  stalenessMs: number | null;
  lastSuccess: string | null;
}

let latestScrape: ScrapeStatus | null = null;
const scrapeListeners = new Set<() => void>();

function readScrapeStatus(headers: Headers): ScrapeStatus {
  const rawStaleness = headers.get("X-Scrape-Staleness-Ms");
  const parsed = rawStaleness == null ? Number.NaN : Number.parseInt(rawStaleness, 10);
  const lastSuccess = headers.get("X-Scrape-Last-Success");
  return {
    down: headers.get("X-Scrape-Down") === "true",
    stalenessMs: Number.isFinite(parsed) ? parsed : null,
    lastSuccess: lastSuccess ? lastSuccess : null,
  };
}

function recordScrapeStatus(headers: Headers): void {
  const next = readScrapeStatus(headers);
  if (
    latestScrape !== null &&
    latestScrape.down === next.down &&
    latestScrape.stalenessMs === next.stalenessMs &&
    latestScrape.lastSuccess === next.lastSuccess
  ) {
    return; // unchanged: do not wake subscribers every 15s poll
  }
  latestScrape = next;
  for (const listener of [...scrapeListeners]) listener();
}

/** Snapshot for useSyncExternalStore. Null until the first series response. */
export function getScrapeStatus(): ScrapeStatus | null {
  return latestScrape;
}

export function subscribeScrape(listener: () => void): () => void {
  scrapeListeners.add(listener);
  return () => {
    scrapeListeners.delete(listener);
  };
}

function buildQuery(params?: Record<string, string | undefined>): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

async function getJson<T>(
  path: string,
  params?: Record<string, string | undefined>,
  onResponse?: (headers: Headers) => void,
): Promise<T> {
  const url = `${BASE}${path}${buildQuery(params)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`API request failed: ${res.status} ${res.statusText} (${url})`);
  }
  onResponse?.(res.headers);
  return (await res.json()) as T;
}

export function fetchKpis(range: Range): Promise<Kpi> {
  return getJson<Kpi>("/kpis", { range });
}

export function fetchSeries(metric: Metric, range: Range, group?: string): Promise<MetricPoint[]> {
  return getJson<MetricPoint[]>("/series", { metric, range, group }, recordScrapeStatus);
}

export function fetchBreakdown(metric: Metric, range: Range): Promise<Breakdown[]> {
  return getJson<Breakdown[]>("/breakdown", { metric, range });
}

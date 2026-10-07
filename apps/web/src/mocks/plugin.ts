// Vite dev-server plugin that serves mock LiteLLM API endpoints as connect-style
// middleware. Active only in `vite dev` (apply: "serve"); never bundled into build.
// request/response handling stays inline so req/res/next types are inferred from
// Vite's own types — no express, MSW, or @types/node import.
import type { Plugin } from "vite";
import type { GroupBy } from "./data";
import { fleetSeries, type FleetGroup } from "./fleet";
import { kpisFor, seriesFor, breakdownFor, snapshot } from "./data";
import type { Metric, Range } from "../lib/types";

// Valid enum values per endpoint (mirrors ../lib/types unions).
const RANGES: Range[] = ["1h", "24h", "7d"];
const SERIES_METRICS: Metric[] = ["requests", "errors", "spend", "tokens", "latency"];
const GROUPS: GroupBy[] = ["model", "api_provider"];
const BREAKDOWN_METRICS: ("spend" | "tokens")[] = ["spend", "tokens"];
type BreakdownMetric = (typeof BREAKDOWN_METRICS)[number];

const SSE_INTERVAL_MS = 5000;

export function mockApiPlugin(): Plugin {
  return {
    name: "prismschism-mock-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // `req` is typed via Vite's bundled Connect namespace; its base http
        // class is unresolved here, so read `url` through a structural cast.
        const url = new URL((req as { url?: string }).url ?? "/", "http://vite.mock");

        // JSON helper (closes over `res` so its type stays inferred from Vite).
        const sendJson = (payload: unknown, status: number = 200): void => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify(payload));
        };

        // Only mock /api/*; everything else falls through to Vite.
        if (!url.pathname.startsWith("/api/")) {
          next();
          return;
        }

        const params = url.searchParams;

        // --- GET /api/kpis?range= ---
        if (url.pathname === "/api/kpis") {
          const range = (params.get("range") ?? "1h") as Range;
          if (!RANGES.includes(range)) {
            sendJson({ error: "invalid range" }, 400);
            return;
          }
          sendJson(kpisFor(range));
          return;
        }

        // --- GET /api/series?metric=&range=&group= ---
        if (url.pathname === "/api/series") {
          const metric = (params.get("metric") ?? "requests") as Metric;
          const range = (params.get("range") ?? "1h") as Range;
          const fleet = fleetSeries(metric, range, (params.get("group") ?? "model") as FleetGroup);
          if (RANGES.includes(range) && fleet) {
            sendJson(fleet);
            return;
          }
          const group = (params.get("group") ?? "model") as GroupBy;
          if (
            !SERIES_METRICS.includes(metric) ||
            !RANGES.includes(range) ||
            !GROUPS.includes(group)
          ) {
            sendJson({ error: "invalid enum" }, 400);
            return;
          }
          sendJson(seriesFor(metric, range, group));
          return;
        }

        // --- GET /api/breakdown?metric=&range= ---
        if (url.pathname === "/api/breakdown") {
          const metric = (params.get("metric") ?? "spend") as BreakdownMetric;
          const range = (params.get("range") ?? "24h") as Range;
          if (!BREAKDOWN_METRICS.includes(metric) || !RANGES.includes(range)) {
            sendJson({ error: "invalid enum" }, 400);
            return;
          }
          sendJson(breakdownFor(metric, range));
          return;
        }

        // --- GET /api/stream  (Server-Sent Events) ---
        if (url.pathname === "/api/stream") {
          let tick = 0;
          const writeFrame = (): void => {
            const frame = `event: message\ndata: ${JSON.stringify(snapshot(tick))}\n\n`;
            tick += 1;
            try {
              res.write(frame); // swallow broken-pipe writes on client disconnect
            } catch {
              /* no-op */
            }
          };

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          (res as { flushHeaders?: () => void }).flushHeaders?.();

          writeFrame(); // first frame immediately
          const timer = setInterval(writeFrame, SSE_INTERVAL_MS);
          res.on("close", () => clearInterval(timer));
          return;
        }

        // Unknown /api/* route.
        sendJson({ error: "not found" }, 404);
      });
    },
  };
}

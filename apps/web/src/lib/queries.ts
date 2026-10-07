// TanStack Query v5 hooks wrapping the fetch-only API client.
// REST is the reconnect/fallback path: refetchInterval 15000.
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchBreakdown,
  fetchKpis,
  fetchSeries,
  getScrapeStatus,
  subscribeScrape,
  type ScrapeStatus,
} from "./api";
import type { Metric, Range } from "./types";

const REFETCH_INTERVAL = 15000;

export function useKpis(range: Range) {
  return useQuery({
    queryKey: ["kpis", range],
    queryFn: () => fetchKpis(range),
    refetchInterval: REFETCH_INTERVAL,
  });
}

export function useSeries(metric: Metric, range: Range, group?: string) {
  return useQuery({
    queryKey: ["series", metric, range, group],
    queryFn: () => fetchSeries(metric, range, group),
    refetchInterval: REFETCH_INTERVAL,
  });
}

export function useBreakdown(metric: Metric, range: Range) {
  return useQuery({
    queryKey: ["breakdown", metric, range],
    queryFn: () => fetchBreakdown(metric, range),
    refetchInterval: REFETCH_INTERVAL,
  });
}

/**
 * Scrape health captured from the X-Scrape-* response headers of the series
 * polls (see lib/api.ts). Rides the existing /api/series fetches — no extra
 * request. Null until the first series response has landed.
 */
export function useScrapeStatus(): ScrapeStatus | null {
  return useSyncExternalStore(subscribeScrape, getScrapeStatus, getScrapeStatus);
}

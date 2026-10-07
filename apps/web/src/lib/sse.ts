// SSE live client. Pushes snapshots into the
// TanStack Query cache so the UI updates via push. The REST useQuery hooks
// (refetchInterval 15000) remain the fallback while SSE is down.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DeploymentHealth, Kpi, Range, StreamSnapshot } from "./types";

const STREAM_URL = "/api/stream";

export function useLiveKpis(range: Range = "1h") {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Guard for non-browser / unsupported environments.
    if (typeof EventSource === "undefined") return;

    const es = new EventSource(STREAM_URL);

    // Docs specify the default (unnamed) "message" event via onmessage.
    es.onmessage = (event: MessageEvent) => {
      let snapshot: StreamSnapshot;
      try {
        snapshot = JSON.parse(event.data) as StreamSnapshot;
      } catch {
        return; // ignore malformed frames
      }
      if (snapshot.kpis) {
        queryClient.setQueryData<Kpi>(["kpis", range], snapshot.kpis);
      }
      if (snapshot.trafficLights) {
        queryClient.setQueryData<DeploymentHealth[]>(["health"], snapshot.trafficLights);
      }
      // snapshot.tpm (if present) is available for Task 4 consumers; no REST fallback key defined.
    };

    es.onerror = () => {
      // SSE dropped: close it. The REST useQuery refetchInterval:15000 keeps data fresh.
      es.close();
    };

    return () => {
      es.close(); // clean teardown on unmount / range change
    };
  }, [queryClient, range]);
}

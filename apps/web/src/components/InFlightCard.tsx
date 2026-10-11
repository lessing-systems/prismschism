// In-flight gauge + distinct sessions card, fed by the /api/inflight poll
// (useInflight, 15s refetch). The gauge degrades to { ts: null, value: null }
// — with a 200 — while the in_flight table is missing, and reads the same
// shape with no sample yet; both null cases render the EMPTY_STAT em-dash
// plus a "no sample yet" hint rather than a 0. Backend lanes (running/max,
// tabular-nums, em-dash when either is null) list under the sessions block
// and are hidden entirely while `backends` is empty (pre-migration 010).
import { useEffect, useState } from 'react';
import { useInflight } from '@/lib/queries';
import { formatStat } from '@/lib/stats';

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function InFlightCard({ windowMinutes }: { windowMinutes?: number }) {
  const query = useInflight(windowMinutes);
  // Re-render once a second so "Ns ago" stays honest between 15s polls
  // (same tick pattern as LiveStatus).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (query.isLoading) {
    return (
      <div data-testid="in-flight-card" className="surface p-4" aria-busy="true">
        <div className="eyebrow">In-flight sessions</div>
        <div className="mt-2 h-9 w-24 animate-pulse rounded-lg bg-muted" />
        <div className="mt-3 h-3 w-40 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div data-testid="in-flight-card" className="surface p-4">
        <div className="mb-3 text-sm font-semibold text-foreground">In-flight sessions</div>
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span aria-hidden="true">!</span>
          Failed to load in-flight sessions
        </div>
      </div>
    );
  }

  const { inflight, sessions, backends } = query.data;
  const ago = inflight.ts ? Math.max(0, Math.round((now - Date.parse(inflight.ts)) / 1000)) : null;

  return (
    <div data-testid="in-flight-card" className="surface p-4">
      <div className="eyebrow">In-flight sessions</div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">
          {formatStat(inflight.value)}
        </span>
        {inflight.value !== null && <span className="text-sm text-muted-foreground">{inflight.unit}</span>}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {inflight.value === null ? (
          <span>no sample yet — gauge needs the in_flight table and at least one sample</span>
        ) : inflight.ts ? (
          <span className="font-mono text-[11px]">
            sampled {ago != null && ago < 120 ? `${ago}s ago` : clock(inflight.ts)}
          </span>
        ) : null}
      </div>

      <div className="mt-4 flex items-baseline gap-1.5 text-xs">
        <span className="tabular-nums font-semibold text-foreground">
          {sessions.distinctTotal.toLocaleString('en-US')}
        </span>
        <span className="text-muted-foreground">distinct sessions ({sessions.windowMinutes}m)</span>
      </div>

      {sessions.byModel.length > 0 && (
        <ul className="mt-2 divide-y divide-border text-xs">
          {sessions.byModel.map((m) => (
            <li key={m.modelId} className="flex items-center justify-between gap-3 py-1.5">
              <span className="truncate font-mono text-muted-foreground" title={m.modelId}>
                {m.modelId}
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {m.distinct.toLocaleString('en-US')}
              </span>
            </li>
          ))}
        </ul>
      )}

      {backends.length > 0 && (
        <div data-testid="backends-section" className="mt-4">
          <div className="text-xs text-muted-foreground">Backends</div>
          <ul className="mt-1 divide-y divide-border text-xs">
            {backends.map((b) => (
              <li key={b.backend} className="flex items-center justify-between gap-3 py-1.5">
                <span className="truncate font-mono text-muted-foreground" title={b.backend}>
                  {b.backend}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums text-foreground">
                    {b.running === null || b.max === null ? '\u2014' : `${b.running}/${b.max}`}
                  </span>
                  {typeof b.waiting === 'number' && b.waiting > 0 && (
                    <span className="tabular-nums text-destructive">+{b.waiting} waiting</span>
                  )}
                  {b.waiting === 0 && (
                    <span className="tabular-nums text-muted-foreground">0 waiting</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

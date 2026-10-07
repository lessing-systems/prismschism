// Header pill summarising scrape health from the X-Scrape-* headers that ride
// the series polls (lib/api.ts). Same 75s threshold as the in-panel banner.
import { useEffect, useState } from 'react';
import { useScrapeStatus } from '@/lib/queries';
import { StateDot } from '@/components/StateIndicator';

const SCRAPE_DOWN_MS = 75_000;

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function LiveStatus() {
  const scrape = useScrapeStatus();
  // Re-render once a second so "Ns ago" stays honest between 15s polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!scrape) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground/50" />
        Connecting…
      </span>
    );
  }

  const stale = scrape.down || (scrape.stalenessMs ?? 0) >= SCRAPE_DOWN_MS;
  const ago = scrape.lastSuccess ? Math.max(0, Math.round((now - Date.parse(scrape.lastSuccess)) / 1000)) : null;

  return (
    <span
      data-testid="live-status"
      title={scrape.lastSuccess ? `Last successful scrape ${scrape.lastSuccess}` : undefined}
      className="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1.5 text-xs"
    >
      <StateDot state={stale ? 'error' : 'healthy'} size="sm" />
      <span className="font-medium text-foreground">{stale ? (scrape.down ? 'Scrape down' : 'Scrape stale') : 'Live'}</span>
      {scrape.lastSuccess && (
        <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
          {ago != null && ago < 120 ? `${ago}s ago` : clock(scrape.lastSuccess)}
        </span>
      )}
    </span>
  );
}

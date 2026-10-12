import { useEffect, useState } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { RangeToggle, RANGES } from '@/components/RangeToggle';
import { LiveStatus } from '@/components/LiveStatus';
import { FleetMetricsPanel } from '@/components/FleetMetricsPanel';
import { InFlightCard } from '@/components/InFlightCard';
import { ErrorsPage } from '@/components/ErrorsPage';
import { VendorCredit } from '@/components/VendorCredit';
import { cn } from '@/lib/utils';
import type { Range } from '@/lib/types';

type Tab = 'live' | 'errors';
const TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'errors', label: 'Errors' },
];

// Lightweight tab switcher (no router dependency): same pill vocabulary as
// RangeToggle. "Live" is the pre-existing dashboard; "Errors" is the
// unified error history.
function TabSwitcher({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  return (
    <div role="tablist" aria-label="View" className="flex items-center rounded-full border border-border bg-card/80 p-1 text-xs font-medium">
      {TABS.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              'rounded-full px-3 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

const RANGE_KEY = 'prismschism:range';

// Per-viewer convenience only: the selected range survives a reload.
function readRange(): Range {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    if (RANGES.some((r) => r.id === v)) return v as Range;
  } catch {
    /* localStorage unavailable */
  }
  return '1h';
}

function LogoMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="h-8 w-8 shrink-0">
      <rect width="32" height="32" rx="9" fill="hsl(var(--primary))" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="none" stroke="hsl(var(--brand))" strokeOpacity="0.5" />
      <path d="M7 20.5 L12 14 L16.5 18 L21 10 L25 15" fill="none" stroke="hsl(var(--brand))" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="15" r="2" fill="hsl(var(--brand))" />
    </svg>
  );
}

function App() {
  const [range, setRange] = useState<Range>(readRange);
  const [tab, setTab] = useState<Tab>('live');
  useEffect(() => {
    try {
      localStorage.setItem(RANGE_KEY, range);
    } catch {
      /* localStorage unavailable */
    }
  }, [range]);

  return (
    <div className="min-h-screen text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/75 backdrop-blur-md">
        <div className="mx-auto flex max-w-[2400px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6 lg:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <LogoMark />
            <div className="min-w-0 leading-tight">
              <h1 className="truncate text-[15px] font-semibold tracking-tight">Prismschism</h1>
              <p className="truncate text-xs text-muted-foreground">Self-hosted model throughput &amp; health</p>
            </div>
            <VendorCredit />
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 sm:gap-3">
            <LiveStatus />
            <TabSwitcher value={tab} onChange={setTab} />
            <RangeToggle value={range} onChange={setRange} />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[2400px] px-4 pb-16 pt-6 sm:px-6 lg:px-10">
        {tab === 'live' ? (
          <>
            <div className="mb-6">
              <InFlightCard />
            </div>
            <FleetMetricsPanel range={range} />
          </>
        ) : (
          <ErrorsPage />
        )}
      </main>
    </div>
  );
}

export default App;

import { useEffect, useState } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { RangeToggle, RANGES } from '@/components/RangeToggle';
import { LiveStatus } from '@/components/LiveStatus';
import { FleetMetricsPanel } from '@/components/FleetMetricsPanel';
import { VendorCredit } from '@/components/VendorCredit';
import type { Range } from '@/lib/types';

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
            <RangeToggle value={range} onChange={setRange} />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[2400px] px-4 pb-16 pt-6 sm:px-6 lg:px-10">
        <FleetMetricsPanel range={range} />
      </main>
    </div>
  );
}

export default App;

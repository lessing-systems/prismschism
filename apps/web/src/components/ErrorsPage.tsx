// Errors tab: unified error history from /api/errors (useErrors, 30s
// refetch). Sysadmin-facing: newest first (API order — preserved, never
// re-sorted), severity dot, kind chip whose tooltip carries the full detail
// sentence, subject in mono, timestamp, count badge — plus the detail
// sentence as a visible muted second line (sysadmins scan text, so the
// explanation is never tooltip-only).
import { useErrors } from '@/lib/queries';
import type { ErrorKind } from '@/lib/api';
import { cn } from '@/lib/utils';

const WINDOW_HOURS = 24;
const LIMIT = 200;

// Short human labels per kind (full sentences live in docs/error-states.md
// and in each event's `detail`).
const KIND_LABEL: Record<ErrorKind, string> = {
  cooldown: 'Upstream 500',
  'state-error': 'Deployment unhealthy',
  'lane-wait': 'Lanes saturated',
  'scrape-fail': 'Metrics scrape failed',
};

// Same clock conventions as the neighbors (InFlightCard): en-GB, 2-digit
// fields. History view, so the short date rides along.
function timestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Severity dot: error = destructive token, warning = the theme's amber
// token (state-prefill — same hue as --warning, which is not mapped in
// tailwind.config). No hardcoded colors.
const SEVERITY_DOT: Record<'error' | 'warning', string> = {
  error: 'bg-destructive',
  warning: 'bg-state-prefill',
};

function SeverityDot({ severity }: { severity: 'error' | 'warning' }) {
  return (
    <span
      data-testid="severity-dot"
      aria-label={`${severity} severity`}
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[severity])}
    />
  );
}

function KindChip({ kind, detail }: { kind: ErrorKind; detail: string }) {
  // Tooltip reuses the app's hover/focus-visible pattern from
  // FleetMetricsPanel's summary tiles (group + role="tooltip", keyboard
  // reachable), on the chip itself. The detail line below is always visible.
  return (
    <span
      tabIndex={0}
      aria-label={detail}
      title={detail}
      className={cn(
        'group/chip relative inline-flex shrink-0 cursor-help items-center rounded-full border border-border bg-card/80 px-2 py-0.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {KIND_LABEL[kind]}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-30 mt-1.5 w-60 rounded-lg border border-border bg-card px-2.5 py-2 text-[11px] font-medium normal-case leading-snug tracking-normal text-muted-foreground opacity-0 shadow-lg transition-opacity duration-150 group-hover/chip:opacity-100 group-focus-within/chip:opacity-100"
      >
        {detail}
      </span>
    </span>
  );
}

export function ErrorsPage() {
  const query = useErrors(WINDOW_HOURS, LIMIT);

  return (
    <div data-testid="errors-page">
      <div className="mb-6">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">Errors</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Latest first. Full explanations: docs/error-states.md in the repo.
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">last 24h</p>
      </div>

      {query.isLoading ? (
        // Loading skeleton, per InFlightCard's pulse-block pattern.
        <div className="surface p-4" aria-busy="true">
          <div className="space-y-3">
            <div className="h-3 w-40 animate-pulse rounded bg-muted" />
            <div className="h-3 w-64 animate-pulse rounded bg-muted" />
            <div className="h-3 w-52 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ) : query.isError || !query.data ? (
        // Failure state: the InlineError-style destructive block.
        <div className="surface p-4">
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span aria-hidden="true">!</span>
            Failed to load errors
          </div>
        </div>
      ) : query.data.errors.length === 0 ? (
        <div className="surface p-4 text-xs text-muted-foreground">No errors in the last 24h.</div>
      ) : (
        <ul data-testid="errors-list" className="surface divide-y divide-border p-4">
          {/* API order (ts DESC) — preserved verbatim, never re-sorted. */}
          {query.data.errors.map((e, i) => (
            <li key={`${e.ts}-${e.kind}-${e.subject}-${i}`} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <SeverityDot severity={e.severity} />
                <KindChip kind={e.kind} detail={e.detail} />
                <span className="min-w-0 truncate font-mono text-muted-foreground" title={e.subject}>
                  {e.subject}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                  {timestamp(e.ts)}
                </span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 tabular-nums text-foreground">
                  ×{e.count}
                </span>
              </div>
              <p className="mt-1 pl-5 text-xs leading-snug text-muted-foreground">{e.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { cn } from '@/lib/utils';
import type { Range } from '@/lib/types';

export const RANGES: { id: Range; label: string }[] = [
  { id: '1h', label: '1h' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
];

export function RangeToggle({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="flex items-center rounded-full border border-border bg-card/80 p-1 text-xs font-medium"
    >
      {RANGES.map((r) => {
        const active = value === r.id;
        return (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(r.id)}
            className={cn(
              'rounded-full px-3 py-1 tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

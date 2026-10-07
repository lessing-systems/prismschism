import { useTheme } from '@/theme/ThemeProvider';
import { cn } from '@/lib/utils';

// D1 runtime theme switcher. Each swatch scopes its own data-theme attribute,
// so it previews that scheme's real tokens (canvas, card, brand) straight from
// index.css — no duplicated hex values here.
export function ThemeToggle() {
  const { scheme, setScheme, schemes } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Color scheme"
      className="flex items-center gap-1 rounded-full border border-border bg-card/80 p-1"
    >
      {schemes.map((s) => {
        const active = scheme === s.id;
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={s.label}
            title={s.label}
            onClick={() => setScheme(s.id)}
            className={cn(
              'group rounded-full p-0.5 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'ring-2 ring-brand/80' : 'ring-0 hover:ring-1 hover:ring-border',
            )}
          >
            <span
              data-theme={s.id}
              aria-hidden="true"
              className="relative block h-6 w-6 overflow-hidden rounded-full border border-white/10"
              style={{ background: 'hsl(var(--background))' }}
            >
              <span
                className="absolute inset-x-0 bottom-0 h-1/2"
                style={{ background: 'hsl(var(--card))' }}
              />
              <span
                className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full"
                style={{ background: 'hsl(var(--brand))' }}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}

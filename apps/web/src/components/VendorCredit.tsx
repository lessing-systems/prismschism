// "by lessing.systems" credit for the header. The mark and wordmark mirror the
// logo on https://lessing.systems in its dark-mode colours; they are brand
// colours, so they deliberately do NOT follow the dashboard theme tokens.
// Hidden via VITE_SHOW_CREDIT (src/lib/credit.ts) — the divider goes with it.
import { isCreditEnabled } from '@/lib/credit';

const SITE_URL = 'https://lessing.systems';

export function VendorCredit() {
  if (!isCreditEnabled()) return null;
  return (
    <>
      <span aria-hidden="true" className="ml-2 hidden h-6 w-px bg-border md:block" />
      <a
        data-testid="vendor-credit"
        href={SITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Built by lessing.systems (opens in a new tab)"
        title="Built by lessing.systems"
        className="hidden items-center gap-2 rounded-md py-1 pr-1 opacity-75 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
      >
        <span aria-hidden="true" className="text-[11px] text-muted-foreground">
          by
        </span>
        <svg width="15" height="18" viewBox="0 0 34 40" aria-hidden="true" focusable="false">
          <path d="M12 1h13L16 30h16l-5 9H2z" fill="#2f7fcb" />
          <path
            d="M9 11 12 1h13"
            fill="none"
            stroke="#e4f23a"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
        </svg>
        <span
          aria-hidden="true"
          className="text-[13px] font-semibold leading-none"
          style={{ fontFamily: "'Schibsted Grotesk', system-ui, sans-serif", color: '#f2f5fa' }}
        >
          lessing<span style={{ color: '#5aa6f0' }}>.systems</span>
        </span>
      </a>
    </>
  );
}

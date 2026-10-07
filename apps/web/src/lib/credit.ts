// Feature flag for the "by lessing.systems" credit in the header.
//
// ON BY DEFAULT: unset or empty VITE_SHOW_CREDIT shows the credit. "0",
// "false", "off" or "no" (case-insensitive, trimmed) hide it; any other value
// keeps it on. Like VITE_DEBUG it is read from the web container's environment
// by the Vite dev server (see docker-compose.yml); a production `vite build`
// bakes the value in at build time. The browser-tab icon is configured
// separately (FAVICON, see favicon.ts).
export function isCreditEnabled(): boolean {
  const raw = import.meta.env.VITE_SHOW_CREDIT;
  if (raw === undefined || raw === null || raw === "") return true;
  const value = String(raw).trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

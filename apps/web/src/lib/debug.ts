// Debug-only feature-flag plumbing. This module is the app's only reader of
// import.meta.env: Vite forwards VITE_-prefixed vars and the web container runs
// the Vite dev server (no build step), so the value comes from the container
// environment at runtime.

// The API ALWAYS emits this group and never filters it server-side, so the client
// owns its visibility: the "unassigned" card is a debug-only affordance.
export const UNASSIGNED_GROUP = "unassigned";

/**
 * True when the debug-only UI (currently: the "unassigned" back-end card) is on.
 *
 * ON BY DEFAULT: an unset or empty VITE_DEBUG means on, because the card ships
 * visible until it is no longer wanted. The flag is on when the value is "1" or
 * "true" (case-insensitive, whitespace-trimmed); anything else — "0", "false",
 * "off" — turns it off.
 */
export function isDebugEnabled(): boolean {
  const raw = import.meta.env.VITE_DEBUG;
  if (raw === undefined || raw === null || raw === "") return true;
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true";
}

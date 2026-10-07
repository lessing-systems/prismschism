/// <reference types="vite/client" />

// Typed subset of the Vite-injected client env. These are the app's first
// import.meta.env usages; Vite only forwards VITE_-prefixed vars to the client,
// and the web container runs the Vite dev server, so they are read at runtime.
// ImportMeta itself comes from vite/client — do not redeclare it here.
interface ImportMetaEnv {
  /** Toggles the debug-only "unassigned" back-end card. On when "1" or "true",
   *  and on by default when unset. See src/lib/debug.ts. */
  readonly VITE_DEBUG?: string;
  /** Optional override for the fleet panel's top-N display cap (clamped in
   *  src/lib/topGroups.ts). */
  readonly VITE_TOP_N?: string;
  /** Shows the "by lessing.systems" header credit. On by default; "0",
   *  "false", "off" or "no" hide it. See src/lib/credit.ts. */
  readonly VITE_SHOW_CREDIT?: string;
}

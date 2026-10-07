// Browser-tab icon, chosen by the FAVICON environment variable when the HTML is
// served (vite.config.ts faviconPlugin; a production build bakes it in).
// Independent of the header credit flag (VITE_SHOW_CREDIT).
//
//   unset / empty  -> the lessing.systems "L" mark (index.html defaults:
//                     /favicon.svg, /favicon-32.png, /apple-touch-icon.png)
//   NONE           -> no icon; an empty data: icon stops the browser from
//                     requesting /favicon.ico
//   anything else  -> the user's own icon, by URL or path, e.g.
//                     /my-icon.png (a file in apps/web/public) or
//                     https://example.com/icon.svg
//
// Pure string work, no import.meta — vite.config.ts imports it at config time.

const DEFAULT_ICONS = /^[ \t]*<link [^>]*data-default-icon[^>]*>\r?\n?/gm;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function iconType(href: string): string {
  const path = href.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".svg")) return ' type="image/svg+xml"';
  if (path.endsWith(".png")) return ' type="image/png"';
  if (path.endsWith(".ico")) return ' type="image/x-icon"';
  return "";
}

/** Rewrite index.html's default icon links according to the FAVICON value. */
export function applyFavicon(html: string, raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (value === "") return html;
  const replacement =
    value.toUpperCase() === "NONE"
      ? '<link rel="icon" href="data:," />'
      : `<link rel="icon"${iconType(value)} href="${escapeAttr(value)}" />`;
  let first = true;
  return html.replace(DEFAULT_ICONS, (match) => {
    if (!first) return "";
    first = false;
    const indent = /^[ \t]*/.exec(match)?.[0] ?? "";
    return `${indent}${replacement}\n`;
  });
}

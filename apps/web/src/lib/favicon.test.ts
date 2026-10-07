import { describe, expect, it } from "vitest";
import { applyFavicon } from "./favicon";

const HTML = [
  "<head>",
  "    <title>x</title>",
  '    <link rel="icon" type="image/svg+xml" href="/favicon.svg" data-default-icon />',
  '    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" data-default-icon />',
  '    <link rel="apple-touch-icon" href="/apple-touch-icon.png" data-default-icon />',
  "</head>",
].join("\n");

const icons = (html: string) => html.match(/<link [^>]*>/g) ?? [];

describe("applyFavicon", () => {
  it.each([undefined, null, "", "   "])("keeps the lessing.systems defaults for %j", (raw) => {
    expect(applyFavicon(HTML, raw)).toBe(HTML);
  });

  it("NONE (any case) removes every icon and blocks the /favicon.ico request", () => {
    for (const raw of ["NONE", "none", " None "]) {
      expect(icons(applyFavicon(HTML, raw))).toEqual(['<link rel="icon" href="data:," />']);
    }
  });

  it("uses a custom path or URL, typed by extension", () => {
    expect(icons(applyFavicon(HTML, "/my-icon.png"))).toEqual([
      '<link rel="icon" type="image/png" href="/my-icon.png" />',
    ]);
    expect(icons(applyFavicon(HTML, "https://example.com/i.svg?v=2"))).toEqual([
      '<link rel="icon" type="image/svg+xml" href="https://example.com/i.svg?v=2" />',
    ]);
    expect(icons(applyFavicon(HTML, "/brand/icon"))).toEqual(['<link rel="icon" href="/brand/icon" />']);
  });

  it("escapes the value so it cannot break out of the attribute", () => {
    const out = applyFavicon(HTML, '/x.png"><script>alert(1)</script>');
    expect(out).not.toContain("<script>");
    expect(out).toContain('href="/x.png&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it("keeps the rest of the document and the indentation intact", () => {
    const out = applyFavicon(HTML, "NONE");
    expect(out).toBe(['<head>', '    <title>x</title>', '    <link rel="icon" href="data:," />', '</head>'].join("\n"));
  });
});

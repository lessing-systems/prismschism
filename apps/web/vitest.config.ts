// Vitest config for the web app.
//
// Kept separate from vite.config.ts so the dev server's mockApiPlugin is NOT
// loaded during tests (it is only needed for `vite dev`). The `@` alias is
// re-declared here with an explicit, root-independent path.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    // jsdom: the component contract test renders into a DOM document.
    // (The token test is env-agnostic and also runs fine under jsdom.)
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { mockApiPlugin } from "./src/mocks/plugin";
import { applyFavicon } from "./src/lib/favicon";

// Browser-tab icon from the FAVICON env var: unset = lessing.systems "L" mark,
// NONE = no icon, anything else = a custom icon URL/path (src/lib/favicon.ts).
function faviconPlugin(): Plugin {
  return {
    name: "favicon",
    transformIndexHtml: (html) => applyFavicon(html, process.env.FAVICON),
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    faviconPlugin(),
    ...(process.env.MOCK_API === "true" ? [mockApiPlugin()] : []),
  ],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET || "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
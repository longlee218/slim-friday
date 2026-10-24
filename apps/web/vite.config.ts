import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { pwaOptions } from "./pwa-options";

// Packages loaded through dynamic import (code highlighting, diagrams). They emit hundreds of
// language, theme and diagram chunks that must stay out of the service worker precache.
const LAZY_PACKAGES =
  /node_modules\/(shiki|@shikijs|mermaid|@mermaid-js|cytoscape[^/]*|katex|dagre-d3-es|d3[^/]*|langium|chevrotain[^/]*|@chevrotain|roughjs|khroma)\//;

export default defineConfig({
  plugins: [react(), tailwindcss(), VitePWA(pwaOptions)],
  build: {
    rolldownOptions: {
      output: {
        // A chunk holding lazy-package modules and no app source goes under assets/lazy/
        // (see globIgnores). Bundler helper modules in the same chunk do not matter.
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => LAZY_PACKAGES.test(id)) &&
          !chunk.moduleIds.some((id) => id.includes("/apps/web/src/"))
            ? "assets/lazy/[name]-[hash].js"
            : "assets/[name]-[hash].js",
      },
    },
  },
});

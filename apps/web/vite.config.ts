import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { cspMetaPlugin } from "./csp/csp-meta-plugin.ts";
import { pdfjsWorkerAlias } from "./pdfjs-worker.ts";
import { pwaOptions } from "./pwa-options.ts";

// Packages loaded through dynamic import (code highlighting, diagrams). They emit hundreds of
// language, theme and diagram chunks that must stay out of the service worker precache.
const LAZY_PACKAGES =
  /node_modules\/(shiki|@shikijs|mermaid|@mermaid-js|cytoscape[^/]*|katex|dagre-d3-es|d3[^/]*|langium|chevrotain[^/]*|@chevrotain|roughjs|khroma)\//;

export default defineConfig(({ mode }) => {
  // Only VITE_* variables: they feed the build-time CSP (see csp/csp.ts).
  const env = loadEnv(mode, import.meta.dirname, "VITE_");
  return {
    plugins: [react(), tailwindcss(), VitePWA(pwaOptions), cspMetaPlugin(env)],
    resolve: { alias: pdfjsWorkerAlias },
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
  };
});

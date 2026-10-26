import { defineConfig } from "vitest/config";
import { pdfjsWorkerAlias } from "./pdfjs-worker.ts";

// Tests live in test/ (never src/); jsdom for component tests.
export default defineConfig({
  resolve: { alias: pdfjsWorkerAlias },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});

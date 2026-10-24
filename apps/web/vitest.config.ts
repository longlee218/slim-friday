import { defineConfig } from "vitest/config";

// Tests live in test/ (never src/); jsdom for component tests.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});

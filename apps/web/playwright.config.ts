import { defineConfig } from "@playwright/test";

// Fixed ports: the API's CORS, cookies and passkey origin name the web origin. Everything is served over HTTPS
// (self-signed, via e2e-tls-proxy.ts) because WebKit drops the API's `Secure` cookie over http://localhost.
const API = "https://localhost:8787";
const WEB = "https://localhost:4173";

// The engine and its chat history live for one run, so a run with both browsers would see the first one's messages
// in the second. `bun run e2e` runs one project per run; fail fast on anything else.
const projectArgs = process.argv.flatMap((a, i) =>
  a.startsWith("--project=")
    ? [a.slice(10)]
    : a === "--project" && process.argv[i + 1]
      ? [process.argv[i + 1]]
      : [],
);
// Test workers load this file too, without the CLI arguments.
if (!process.env.TEST_WORKER_INDEX && projectArgs.length !== 1)
  throw new Error(
    "Run exactly one project per run: `playwright test --project=chromium|webkit`, or `bun run e2e`.",
  );

export default defineConfig({
  globalTeardown: "./e2e/global-teardown.ts",
  testDir: "./e2e",
  // One browser at a time. The engine (one owner, one temp home, one chat history) lives for one `playwright test`
  // run, and the spec expects an empty chat: `bun run e2e` therefore runs each project in its own run.
  workers: 1,
  timeout: 60_000,
  use: { baseURL: WEB, ignoreHTTPSErrors: true, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: [
    {
      // The engine (plain http on 8790); writes its temp home to the OS temp dir for `readOwnerLink` (helpers.ts).
      command: "bun ../friday/scripts/e2e-engine.ts",
      url: "http://127.0.0.1:8790/health",
      reuseExistingServer: false,
    },
    {
      command: "bun run build && bun run preview --port 4174 --strictPort",
      url: "http://localhost:4174",
      reuseExistingServer: false,
      timeout: 180_000,
      env: { VITE_API_URL: API },
    },
    {
      // HTTPS on 8787 (API), 4173 (web) and 8788 (files) in front of the three above.
      command: "bun ../friday/scripts/e2e-tls-proxy.ts",
      url: `${API}/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
    },
  ],
});

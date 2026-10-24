import { defineConfig } from "@playwright/test";

// Fixed ports: the API's CORS, cookies and passkey origin name the web origin. Everything is served over HTTPS
// (self-signed, via e2e-tls-proxy.ts) because WebKit drops the API's `Secure` cookie over http://localhost.
const API = "https://localhost:8787";
const WEB = "https://localhost:4173";

export default defineConfig({
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

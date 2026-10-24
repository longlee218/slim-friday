/**
 * Engine for the web e2e (Playwright): the real engine, API and auth over a temp AGENT_HOME, with a scripted
 * runtime and an in-memory file store. Dummy credentials only. Prints `READY <agentHome>` when it listens.
 * `E2E_LIVE_R2=1` keeps the real R2 store (needs real R2_* in the env) to check uploads from Safari.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Browsers reach everything over HTTPS (e2e-tls-proxy.ts): the public origins below; the engine and the file
// server listen on plain loopback ports behind it.
const webOrigin = "https://localhost:4173";
const apiOrigin = "https://localhost:8787";
const apiPort = 8790;
const filesPort = 8789;
const publicFilesUrl = "https://localhost:8788";
const agentHome = mkdtempSync(join(tmpdir(), "friday-e2e-"));
const live = process.env.E2E_LIVE_R2 === "1";

// The logger and config read the env at import time: set it first, then import the engine.
Object.assign(process.env, {
  AGENT_HOME: agentHome,
  API_PORT: apiPort,
  WEB_ORIGIN: webOrigin,
  PUBLIC_API_URL: apiOrigin,
  OWNER_EMAIL: "owner@example.test",
  AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
  CLAUDE_CODE_OAUTH_TOKEN: "e2e-dummy-token",
  LOG_LEVEL: "warn",
  ...(live
    ? {}
    : {
        R2_ACCOUNT_ID: "e2e",
        R2_ACCESS_KEY_ID: "e2e",
        R2_SECRET_ACCESS_KEY: "e2e",
        R2_BUCKET: "e2e",
      }),
});
// The CDN would switch images to public URLs; the e2e checks presigned ones.
delete process.env.CDN;

const { loadConfig } = await import("../src/config/agent-config");
const { startEngine } = await import("../src/main");
const { LocalFileStore, ScriptedRuntime } = await import("./e2e-scripted-runtime");

const store = new LocalFileStore(publicFilesUrl);
const filesServer = live ? undefined : store.serve(filesPort, webOrigin);
const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => ac.abort());

const done = startEngine(
  { config: loadConfig(), agentHome, signal: ac.signal },
  { runtime: new ScriptedRuntime(), ...(live ? {} : { fileStore: store }) },
);
// The API port is bound once startEngine has composed everything; poll /health for the READY line.
for (let i = 0; i < 200; i++) {
  const ok = await fetch(`http://127.0.0.1:${apiPort}/health`).then(
    (r) => r.ok,
    () => false,
  );
  if (ok) break;
  await Bun.sleep(100);
}
// The Playwright spec runs in another process: it finds the home (and the owner links) through this file.
writeFileSync(join(tmpdir(), "friday-e2e-home.txt"), agentHome);
process.stdout.write(`READY ${agentHome}\n`);
await done;
filesServer?.stop(true);
process.exit(0);

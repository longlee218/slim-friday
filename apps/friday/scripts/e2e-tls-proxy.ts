/**
 * HTTPS front for the web e2e. WebKit drops a `Secure` cookie set over plain http://localhost, and the API
 * (rightly) always sets `Secure`, so the browsers reach everything over HTTPS on localhost with a throwaway
 * self-signed certificate (the Playwright config sets `ignoreHTTPSErrors`). Each pair is `https port -> http port`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `[https port, http port, http host]`: 8787 API, 4173 web preview, 8788 file store. */
const PAIRS: Array<[number, number, string]> = [
  [8787, 8790, "127.0.0.1"],
  // `vite preview` listens on `localhost`, which may be IPv6 only.
  [4173, 4174, "localhost"],
  [8788, 8789, "127.0.0.1"],
];

/** Key dirs of earlier runs that were killed: only our own `friday-e2e-tls-` prefix in the OS temp dir. */
function removeStaleKeyDirs(): void {
  for (const name of readdirSync(tmpdir()))
    if (name.startsWith("friday-e2e-tls-"))
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
}

/** A self-signed certificate for localhost, created fresh for every run; the key dir is removed at once. */
function makeCert(): { cert: string; key: string } {
  removeStaleKeyDirs();
  const dir = mkdtempSync(join(tmpdir(), "friday-e2e-tls-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const r = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  try {
    if (r.exitCode !== 0) throw new Error("openssl could not make the e2e certificate");
    // Playwright SIGKILLs this process, so no exit handler could clean up: read, then delete now.
    return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tls = makeCert();
for (const [https, http, host] of PAIRS) {
  Bun.serve({
    port: https,
    hostname: "127.0.0.1",
    tls,
    // Server-sent events stay open and idle between events.
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      // No compression upstream: the body is passed on untouched, so its encoding header would be wrong.
      headers.set("accept-encoding", "identity");
      const res = await fetch(`http://${host}:${http}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
      }).catch(() => new Response("upstream not ready", { status: 502 }));
      return new Response(res.body, { status: res.status, headers: res.headers });
    },
  });
}
process.stdout.write("TLS-PROXY READY\n");

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DB_PATH, leadCostIsCumulative, openReadOnly } from "./db";
import { costSummary } from "./queries-cost";
import { goalDetail, listGoals } from "./queries-goals";
import { liveRuns } from "./queries-live";
import { listProblems } from "./queries-problems";
import { promptOf, promptScopes } from "./queries-prompts";
import { skillUsage } from "./queries-skills";
import { turnDetail } from "./queries-runs";
import { listThreads, threadReplay } from "./queries-threads";

/** Loopback only: payloads hold owner messages and tool output. */
const HOSTNAME = "127.0.0.1";
const PORT = Number(process.env.DASHBOARD_PORT ?? 4318);
const DIST = join(import.meta.dir, "..", "dist");

const db = openReadOnly();

/** `?since=<ms epoch>`; missing = everything. */
function since(url: URL): number {
  return Number(url.searchParams.get("since") ?? 0) || 0;
}

/** JSON 200, or 404 when the lookup found nothing. */
function json(data: unknown): Response {
  return data == null ? Response.json({ error: "not found" }, { status: 404 }) : Response.json(data);
}

/** GET routes: path pattern -> handler. Every handler only reads. */
const routes: [RegExp, (m: RegExpMatchArray, url: URL) => unknown][] = [
  [/^\/api\/meta$/, () => ({ db: DB_PATH, leadCostCumulative: leadCostIsCumulative(db), now: Date.now() })],
  [/^\/api\/live$/, () => liveRuns(db)],
  [/^\/api\/goals$/, (_m, url) => listGoals(db, since(url))],
  [/^\/api\/goals\/([\w-]+)$/, (m) => goalDetail(db, m[1]!)],
  [/^\/api\/turns\/([\w-]+)$/, (m) => turnDetail(db, m[1]!)],
  [/^\/api\/threads$/, (_m, url) => listThreads(db, since(url))],
  [/^\/api\/threads\/(\d+)$/, (m) => threadReplay(db, m[1]!)],
  [/^\/api\/cost$/, (_m, url) => costSummary(db, since(url))],
  [/^\/api\/problems$/, (_m, url) => listProblems(db, since(url))],
  [/^\/api\/skills$/, (_m, url) => skillUsage(db, since(url))],
  [/^\/api\/prompts$/, () => promptScopes()],
  [
    /^\/api\/prompts\/([\w-]+)$/,
    (m, url) =>
      promptOf(m[1]!, url.searchParams.get("workspace") ?? undefined, url.searchParams.get("channel") ?? undefined),
  ],
];

/** Built UI from dist/ (after `bun run build`); unknown paths fall back to index.html. */
function serveStatic(pathname: string): Response {
  const file = join(DIST, pathname);
  if (pathname !== "/" && file.startsWith(DIST) && existsSync(file)) return new Response(Bun.file(file));
  const index = join(DIST, "index.html");
  // no-cache: index.html names the hashed bundles, so a stale copy would load an old build.
  if (existsSync(index)) return new Response(Bun.file(index), { headers: { "cache-control": "no-cache" } });
  return new Response("UI not built: run `bun run build`, or `bun run dev` and open :5173", { status: 404 });
}

Bun.serve({
  hostname: HOSTNAME,
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "GET") return new Response("read-only", { status: 405 });
    if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname);
    for (const [re, handler] of routes) {
      const m = url.pathname.match(re);
      if (!m) continue;
      try {
        return json(handler(m, url));
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }
    return Response.json({ error: "unknown route" }, { status: 404 });
  },
});

process.stdout.write(`friday ops dashboard: http://${HOSTNAME}:${PORT} (db ${DB_PATH}, read-only)\n`);

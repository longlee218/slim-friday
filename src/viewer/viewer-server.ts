import type { Database } from "bun:sqlite";
import type { ArtifactKind } from "../artifacts/artifact-kinds";
import type { ViewerConfig } from "../config/viewer-config";
import { logger } from "../observability/logger";
import { getArtifact } from "../storage/artifact-store";
import { type BodyRoots, loadArtifactBody } from "./artifact-body";
import { renderArtifact } from "./render-artifact";
import { verifyLink } from "./signed-link";

/** Logger of this module. Never log a URL, token or the secret: only the artifact id and the outcome. */
const log = logger.child({ module: "viewer" });

/** Headers of EVERY response: no cache, no referrer, no indexing, no sniffing, no framing. */
const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

/** What the viewer reads: the db (artifact rows), the signing config and where files live. */
export interface ViewerDeps {
  db: Database;
  config: ViewerConfig;
  roots: BodyRoots;
}

/** The one answer for anything invalid, expired, unknown or unreadable: no detail. */
const notFound = (): Response =>
  new Response("Not found", {
    status: 404,
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain" },
  });

/** The request handler: `GET /a/:id?e=&s=` only. Exported so tests call it without a socket. */
export function createViewerHandler(deps: ViewerDeps): (req: Request) => Response {
  return (req) => {
    try {
      if (req.method !== "GET") return notFound();
      const url = new URL(req.url);
      const m = /^\/a\/([^/]+)$/.exec(url.pathname);
      if (!m) return notFound();
      const id = decodeURIComponent(m[1] ?? "");
      if (!verifyLink(deps.config.secret, id, url.searchParams.get("e"), url.searchParams.get("s")))
        return notFound();
      const row = getArtifact(deps.db, id); // a deleted (revoked) artifact is a 404 here
      const text = row && loadArtifactBody(row, deps.roots);
      if (!row || text === null) return notFound();
      const page = renderArtifact(row.kind as ArtifactKind, row.title, text);
      return new Response(page.html, {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": page.csp,
        },
      });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.name : "error" }, "viewer request failed");
      return notFound();
    }
  };
}

/** Start the viewer on 127.0.0.1 (the Cloudflare Tunnel reaches it there). Returns the stop function. Throws when the port is taken. */
export function startViewer(deps: ViewerDeps): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: deps.config.port,
    fetch: createViewerHandler(deps),
  });
  log.info({ port: server.port }, "viewer started");
  return { port: server.port ?? deps.config.port, stop: () => void server.stop(true) };
}

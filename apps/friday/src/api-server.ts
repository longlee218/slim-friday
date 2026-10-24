import { join } from "node:path";
import {
  type ApiLog,
  createApiApp,
  createOwnerAuth,
  type EngineDeps,
  ensureOwner,
} from "@friday/api";
import { openAuthDb } from "@friday/store-sqlite";
import { homePaths } from "./config/home-paths";
import { systemClock } from "./system-clock";

/** Everything the web API needs to start; values come from `AgentConfig`. */
export interface ApiServerOptions {
  agentHome: string;
  /** TCP port on 127.0.0.1; 0 picks a free one. */
  port: number;
  webOrigin: string;
  publicApiUrl: string;
  authSecret: string;
  ownerEmail: string;
  log: ApiLog;
  /** Public CDN URL for images; undefined = presigned. */
  cdnUrl?: string;
  /** Engine handles for the engine-backed routes (hub, store, surface, files, purge). */
  engine: EngineDeps;
}

/**
 * Start the web API (Hono on 127.0.0.1) over the engine db: open the auth db, seed the owner,
 * listen. A failed listen closes the db and throws a named error. `stop()` is idempotent.
 */
export async function startApiServer(
  o: ApiServerOptions,
): Promise<{ port: number; stop(): Promise<void> }> {
  const authDb = openAuthDb(join(o.agentHome, "data", "engine.db"));
  try {
    const auth = createOwnerAuth({
      db: authDb.db,
      schema: authDb.schema,
      secret: o.authSecret,
      baseURL: o.publicApiUrl,
      webOrigin: o.webOrigin,
      ownerEmail: o.ownerEmail,
      ownerLinksFile: homePaths(o.agentHome).ownerLinks,
      now: systemClock.now,
      log: o.log,
    });
    const state = await ensureOwner(auth, o.ownerEmail);
    o.log.info({ event: "auth.owner", state }, "auth.owner");
    const app = createApiApp({
      auth,
      webOrigin: o.webOrigin,
      ownerEmail: o.ownerEmail,
      log: o.log,
      cdnUrl: o.cdnUrl,
      now: systemClock.now,
      dbReachable: authDb.ping,
      ...o.engine,
    });
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: o.port, fetch: app.fetch });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`API server could not listen on 127.0.0.1:${o.port}: ${reason}`);
    }
    const port = server.port as number;
    o.log.info({ event: "api.started", port }, "api.started");
    let stopped = false;
    return {
      port,
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await server.stop(true);
        } finally {
          authDb.close();
        }
      },
    };
  } catch (err) {
    authDb.close();
    throw err;
  }
}

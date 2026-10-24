import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openEngineStore } from "@friday/store-sqlite";
import { WebSurface } from "@friday/surface-web";
import { FakeFileStore } from "../../../packages/core/test/fakes/fake-file-store";
import { systemClock } from "../src/system-clock";

/**
 * The `startApp` parts the engine builds in production, over `home`: the engine db, a fake file store and the web
 * surface on both. The app closes the db when it stops.
 */
export function webParts(home: string) {
  mkdirSync(join(home, "data"), { recursive: true });
  const engine = openEngineStore(join(home, "data", "engine.db"));
  const files = new FakeFileStore();
  const surface = new WebSurface({
    store: engine,
    files,
    clock: systemClock,
    inboxDir: join(home, "inbox"),
  });
  return { engine, files, surface };
}

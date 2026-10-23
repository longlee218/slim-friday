import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { loadLocations } from "../src/locations/location-registry";

/** Fake owner $HOME holding AGENT_HOME (`.friday`) and a project; the location is the whole $HOME. */
const base = realpathSync(mkdtempSync(join(tmpdir(), "friday-homeloc-")));
const home = join(base, "home");
const agentHome = join(home, ".friday");
mkdirSync(join(home, "proj", "node_modules"), { recursive: true });
mkdirSync(join(agentHome, "data"), { recursive: true });
writeFileSync(join(agentHome, ".env"), "SECRET=1");
writeFileSync(join(agentHome, "data", "agent.db"), "x");
const ws = workspacePaths(agentHome).workspace("main");
mkdirSync(ws.root, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** The $HOME location as the registry builds it. */
const [homeLoc] = loadLocations(
  [{ name: "my-computer", path: home }],
  ws,
  [home, agentHome],
  [home],
);

test("registry: $HOME accepted, strict ancestors rejected, AGENT_HOME inside rule unchanged", () => {
  expect(homeLoc?.path).toBe(home);
  const got = loadLocations(
    [
      { name: "root", path: "/" },
      { name: "base", path: base },
      { name: "agent", path: agentHome },
      { name: "data", path: join(agentHome, "data") },
    ],
    ws,
    [home, agentHome],
    [home],
  );
  expect(got).toEqual([]);
});

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/agent-config";
import { workspacePaths } from "../src/config/workspace-paths";
import { loadLocations } from "../src/locations/location-registry";
import { roleScope } from "../src/orchestrator/run/role-scope";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { getRole } from "../src/roles/role-registry";

/** Fake owner $HOME holding AGENT_HOME (`.friday`) and a project; the location is the whole $HOME. */
const base = realpathSync(mkdtempSync(join(tmpdir(), "friday-homeloc-")));
const home = join(base, "home");
const agentHome = join(home, ".friday");
mkdirSync(join(home, "proj", "node_modules"), { recursive: true });
mkdirSync(join(agentHome, "data"), { recursive: true });
writeFileSync(join(agentHome, ".env"), "SECRET=1");
writeFileSync(join(agentHome, "data", "agent.db"), "x");
const config = loadConfig({ AGENT_HOME: agentHome, TIMEOUT_MS: "5000" });
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

/** Guard of one role run in workspace `main` with the $HOME location. */
const guard = (role: "developer" | "lead") => {
  const r = getRole(role);
  const s = roleScope(
    config,
    {
      turnId: "t1",
      threadId: "th",
      text: "x",
      role,
      workspace: "main",
      locations: [homeLoc],
      ac: new AbortController(),
    } as never,
    r,
  );
  return guardFor(r, s.guard);
};
const decide = (role: "developer" | "lead", tool: string, input: Record<string, unknown>) =>
  checkToolCall(tool, input, guard(role)).decision;

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

for (const role of ["developer", "lead"] as const) {
  test(`${role} with a $HOME location: agent home is unreadable`, () => {
    expect(decide(role, "Read", { file_path: join(agentHome, ".env") })).toBe("deny");
    expect(decide(role, "Read", { file_path: join(agentHome, "data", "agent.db") })).toBe("deny");
    expect(decide(role, "Grep", { path: agentHome, pattern: "x" })).toBe("deny");
    expect(decide(role, "Read", { file_path: join(home, "proj", "a.txt") })).toBe("allow");
  });
}

test("dev: agent home unwritable, Bash reads and writes of it denied, own dirs granted", () => {
  expect(decide("developer", "Write", { file_path: join(agentHome, "data", "x") })).toBe("deny");
  expect(decide("developer", "Bash", { command: `cat ${join(agentHome, ".env")}` })).toBe("deny");
  expect(
    decide("developer", "Bash", { command: `cat ${join(agentHome, "data", "agent.db")}` }),
  ).toBe("deny");
  expect(decide("developer", "Bash", { command: `rm -r ${join(agentHome, "x")}` })).toBe("deny");
  // Relative (cwd = $HOME) and `~` / `$HOME` forms (os.homedir() follows the HOME env).
  expect(decide("developer", "Bash", { command: "cat .friday/data/agent.db" })).toBe("deny");
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    expect(decide("developer", "Bash", { command: "ls ~/.friday/data" })).toBe("deny");
    expect(decide("developer", "Bash", { command: "echo hi > $HOME/.friday/data/x" })).toBe("deny");
  } finally {
    process.env.HOME = prevHome;
  }
  // The run's scratch and worktrees dir (under AGENT_HOME) stay writable.
  expect(decide("developer", "Write", { file_path: join(ws.task("t1").root, "plan.md") })).toBe(
    "allow",
  );
  expect(
    decide("developer", "Write", { file_path: join(ws.worktrees, "my-computer", "a.ts") }),
  ).toBe("allow");
  expect(decide("developer", "Bash", { command: `rm -r ${join(ws.worktrees, "x")}` })).toBe(
    "allow",
  );
  expect(
    decide("developer", "Bash", { command: `rm -r ${join(home, "proj", "node_modules")}` }),
  ).toBe("allow");
});

test("lead: files of its own workspace cwd/ stay readable", () => {
  expect(decide("lead", "Read", { file_path: join(ws.cwd, "a.txt") })).toBe("allow");
});

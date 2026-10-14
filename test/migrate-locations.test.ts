import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLocations } from "../src/locations/migrate-locations";
import { formatReport } from "../src/locations/migrate-locations-report";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "friday-migloc-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ws = (n: string) => join(home, "workspaces", n);
const parse = (f: string) => Bun.YAML.parse(readFileSync(f, "utf8")) as Record<string, any>;
const wsYaml = (n: string) => parse(join(ws(n), "workspace.yaml"));

/** Create a workspace with a workspace.yaml (object) and optional legacy repos (name -> repo.yaml text). */
function mkWs(name: string, yaml: object, repos: Record<string, string> = {}): void {
  mkdirSync(join(ws(name), "repos"), { recursive: true });
  writeFileSync(join(ws(name), "workspace.yaml"), Bun.YAML.stringify(yaml, null, 2));
  for (const [n, body] of Object.entries(repos)) {
    mkdirSync(join(ws(name), "repos", n), { recursive: true });
    writeFileSync(join(ws(name), "repos", n, "repo.yaml"), body);
  }
}

describe("migrateLocations", () => {
  test("default clone path moves under locations/", () => {
    mkWs("w", { channels: [] }, { app: "description: App\n" });
    mkdirSync(join(ws("w"), "repos", "app", "repo"));
    writeFileSync(join(ws("w"), "repos", "app", "repo", "f.txt"), "x");
    const r = migrateLocations(home, { apply: true });
    expect(r.applied).toBe(true);
    const y = wsYaml("w");
    expect(y.locations).toEqual([
      { name: "app", path: join(ws("w"), "locations", "app", "repo"), description: "App" },
    ]);
    expect(readFileSync(join(ws("w"), "locations", "app", "repo", "f.txt"), "utf8")).toBe("x");
    expect(existsSync(join(ws("w"), "locations", "app", "repo.yaml"))).toBe(false);
    expect(existsSync(join(ws("w"), "repos"))).toBe(false);
  });

  test("absolute path is kept, checkout not moved", () => {
    const ext = mkdtempSync(join(tmpdir(), "friday-ext-"));
    mkWs("w", { channels: [] }, { app: `path: ${ext}\ndescription: Ext\n` });
    migrateLocations(home, { apply: true });
    expect(wsYaml("w").locations[0].path).toBe(ext);
    expect(existsSync(ext)).toBe(true);
    rmSync(ext, { recursive: true });
  });

  test("relative path is resolved against repos/<n>/ and rewritten when inside", () => {
    mkWs(
      "w",
      { channels: [] },
      { a: "path: ./co\ndescription: A\n", b: "path: ../../../x\ndescription: B\n" },
    );
    mkdirSync(join(ws("w"), "repos", "a", "co"));
    migrateLocations(home, { apply: true });
    const [a, b] = wsYaml("w").locations;
    expect(a.path).toBe(join(ws("w"), "locations", "a", "co"));
    expect(b.path).toBe(join(home, "workspaces", "x"));
  });

  test("empty repos dir gives locations: [] and removes repos/", () => {
    mkWs("w", { description: "d" });
    migrateLocations(home, { apply: true });
    expect(wsYaml("w").locations).toEqual([]);
    expect(existsSync(join(ws("w"), "repos"))).toBe(false);
  });

  test("absent repos dir gives locations: []", () => {
    mkWs("w", { channels: [] });
    rmSync(join(ws("w"), "repos"), { recursive: true });
    migrateLocations(home, { apply: true });
    expect(wsYaml("w").locations).toEqual([]);
  });

  test("second run is a no-op", () => {
    mkWs("w", { channels: ["12345678901234567"] }, { app: "description: A\n" });
    migrateLocations(home, { apply: true });
    const before = readFileSync(join(ws("w"), "workspace.yaml"), "utf8");
    const again = migrateLocations(home, { apply: true });
    expect(again.nothingToDo).toBe(true);
    expect(again.applied).toBe(false);
    expect(formatReport(again)).toContain("nothing to do");
    expect(readFileSync(join(ws("w"), "workspace.yaml"), "utf8")).toBe(before);
    expect(readdirSync(join(home, "backups"))).toHaveLength(1);
  });

  test("dry-run writes nothing; apply writes the backup first", () => {
    mkWs("w", { channels: [] }, { app: "description: A\n" });
    const yamlBefore = readFileSync(join(ws("w"), "workspace.yaml"), "utf8");
    const dry = migrateLocations(home, { apply: false });
    expect(dry.applied).toBe(false);
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(existsSync(join(ws("w"), "repos", "app"))).toBe(true);
    expect(readFileSync(join(ws("w"), "workspace.yaml"), "utf8")).toBe(yamlBefore);

    const r = migrateLocations(home, { apply: true });
    const dir = r.backupDir as string;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, "w", "workspace.yaml"), "utf8")).toBe(yamlBefore);
    expect(existsSync(join(dir, "w", "repos", "app", "repo.yaml"))).toBe(true);
  });

  test("backup skips the moved managed clone", () => {
    mkWs("w", { channels: [] }, { app: "description: A\n" });
    mkdirSync(join(ws("w"), "repos", "app", "repo"));
    writeFileSync(join(ws("w"), "repos", "app", "repo", "big.bin"), "x");
    const r = migrateLocations(home, { apply: true });
    expect(existsSync(join(r.backupDir as string, "w", "repos", "app", "repo"))).toBe(false);
    expect(existsSync(join(r.backupDir as string, "w", "repos", "app", "repo.yaml"))).toBe(true);
  });

  test("symlinked repos/<n> is refused and left in place", () => {
    const target = mkdtempSync(join(tmpdir(), "friday-link-"));
    writeFileSync(join(target, "repo.yaml"), "description: L\n");
    mkWs("w", { channels: [] });
    symlinkSync(target, join(ws("w"), "repos", "link"));
    const r = migrateLocations(home, { apply: true });
    expect(r.plans[0]?.skipped[0]).toContain("symlink");
    expect(wsYaml("w").locations).toEqual([]);
    expect(existsSync(join(ws("w"), "repos", "link"))).toBe(true);
    expect(existsSync(join(ws("w"), "locations", "link"))).toBe(false);
    rmSync(target, { recursive: true });
  });

  test("dropped legacy fields are printed, never written", () => {
    mkWs(
      "w",
      { channels: [] },
      { app: "description: A\ndefaultBranch: main\ntestCommand: bun test\ngithubAccount: me\n" },
    );
    const r = migrateLocations(home, { apply: true });
    const text = formatReport(r).join("\n");
    expect(text).toContain('defaultBranch: "main"');
    expect(text).toContain('testCommand: "bun test"');
    expect(text).toContain('githubAccount: "me"');
    const raw = readFileSync(join(ws("w"), "workspace.yaml"), "utf8");
    expect(raw).not.toContain("defaultBranch");
    expect(raw).not.toContain("bun test");
  });

  test("legacy string channels become objects; first named <ws>-agent", () => {
    mkWs("w", { channels: ["12345678901234567", "76543210987654321"] });
    migrateLocations(home, { apply: true });
    expect(wsYaml("w").channels).toEqual([
      { id: "12345678901234567", name: "w-agent", mode: "task" },
      { id: "76543210987654321", name: "w-agent-2", mode: "task" },
    ]);
  });

  test("other yaml keys are preserved", () => {
    mkWs(
      "w",
      { description: "d", channels: [], skills: { extra: true } },
      { a: "description: A\n" },
    );
    migrateLocations(home, { apply: true });
    const y = wsYaml("w");
    expect(y.skills).toEqual({ extra: true });
    expect(y.description).toBe("d");
    expect(statSync(join(ws("w"), "workspace.yaml")).mode & 0o777).toBe(0o600);
  });

  test("interrupted run (rename fails) is finished by a rerun; other workspaces still apply", () => {
    mkWs("a", { channels: [] }, { app: "description: A\n" });
    mkWs("b", { channels: [] }, { web: "description: W\n" });
    mkdirSync(join(ws("a"), "locations"));
    chmodSync(join(ws("a"), "locations"), 0o500); // the rename into it fails
    try {
      const r = migrateLocations(home, { apply: true });
      expect(r.failed.map((f) => f.workspace)).toEqual(["a"]);
      expect(formatReport(r).join("\n")).toContain("a: FAILED");
      // yaml first: the location is listed with its final path, the dir is still in repos/
      expect(wsYaml("a").locations[0].path).toBe(join(ws("a"), "locations", "app", "repo"));
      expect(existsSync(join(ws("a"), "repos", "app"))).toBe(true);
      expect(existsSync(join(ws("b"), "locations", "web"))).toBe(true);
    } finally {
      chmodSync(join(ws("a"), "locations"), 0o700);
    }
    const again = migrateLocations(home, { apply: true });
    expect(again.failed).toEqual([]);
    expect(existsSync(join(ws("a"), "locations", "app"))).toBe(true);
    expect(existsSync(join(ws("a"), "locations", "app", "repo.yaml"))).toBe(false);
    expect(existsSync(join(ws("a"), "repos"))).toBe(false);
    expect(wsYaml("a").locations).toHaveLength(1);
    expect(migrateLocations(home, { apply: true }).nothingToDo).toBe(true);
  });

  test("a repos/<n> dir without repo.yaml is a note, not a skip; the rerun is nothing to do", () => {
    mkWs("w", { channels: [] }, { app: "description: A\n" });
    mkdirSync(join(ws("w"), "repos", "stale"));
    const r = migrateLocations(home, { apply: true });
    expect(r.plans[0]?.skipped).toEqual([]);
    expect(formatReport(r).join("\n")).toContain("w: note repos/stale: no repo.yaml");
    expect(existsSync(join(ws("w"), "repos", "stale"))).toBe(true);
    expect(migrateLocations(home, { apply: true }).nothingToDo).toBe(true);
  });

  test("a numeric channel id is reported and the workspace is not migrated", () => {
    mkWs("w", { channels: [] }, { app: "description: A\n" });
    writeFileSync(join(ws("w"), "workspace.yaml"), "channels:\n  - 1234567890123456789\n");
    const r = migrateLocations(home, { apply: true });
    expect(r.plans[0]?.skipped[0]).toContain("channels[0]");
    expect(existsSync(join(ws("w"), "repos", "app"))).toBe(true);
    expect(r.nothingToDo).toBe(true);
  });

  test("workspace.yaml has a final newline and no trailing spaces", () => {
    mkWs("w", { channels: [] }, { app: "description: A\n" });
    migrateLocations(home, { apply: true });
    const text = readFileSync(join(ws("w"), "workspace.yaml"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(/[ \t]$/m.test(text)).toBe(false);
  });
});

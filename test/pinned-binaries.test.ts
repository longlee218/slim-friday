import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PINNED_BINARIES,
  type PinnedBinary,
  pinnedBinaryEnv,
  sha256OfFile,
  verifiedBinaryPath,
} from "../src/config/pinned-binaries";
import { ROLES } from "../src/roles/role-registry";
import { PUBLISHER_SKILLS_DIR } from "../src/runtime/skills-plugin/publisher-skills";
import { workerSandbox } from "../src/runtime/worker-sandbox";

/* Phase 2c: native binaries a role's shell runs are pinned by sha256 in data (src/config/data/pinned-binaries.yaml), never
   downloaded at run time; a run gets the env var only for a verified file, and its sandbox may read (not write) it. */

const ROOT = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "pinned-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("every pinned binary has a version, an env var and per-platform path, url and sha256", () => {
  expect(Object.keys(PINNED_BINARIES).length).toBeGreaterThan(0);
  for (const [name, b] of Object.entries(PINNED_BINARIES)) {
    expect([name, typeof b.version, b.env]).toEqual([
      name,
      "string",
      expect.stringMatching(/^[A-Z_]+$/),
    ]);
    for (const p of Object.values(b.platforms)) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.bytes).toBeGreaterThan(0);
      expect(p.path.startsWith("pinned-bin/")).toBe(true); // gitignored dir
      expect(p.url).toContain(b.version);
    }
  }
});

test("the impeccable engine pin matches the version the installed skill's launcher expects", () => {
  const skillVersion = readFileSync(
    join(PUBLISHER_SKILLS_DIR, "impeccable", "scripts", "VERSION"),
    "utf8",
  ).trim();
  expect(PINNED_BINARIES["impeccable-engine"]?.version).toBe(skillVersion);
});

test("an installed pinned file hashes to its pinned sha256 (fails on any change; skipped when not installed)", () => {
  for (const [name, b] of Object.entries(PINNED_BINARIES))
    for (const [platform, p] of Object.entries(b.platforms)) {
      const file = join(ROOT, p.path);
      if (!existsSync(file)) continue; // a fresh clone: install steps in docs/discord-setup.md
      expect([name, platform, sha256OfFile(file)]).toEqual([name, platform, p.sha256]);
    }
});

test("verifiedBinaryPath: only an executable file with the pinned size and hash", () => {
  const file = join(tmp, "tool");
  writeFileSync(file, "engine bytes");
  chmodSync(file, 0o755);
  const spec = (sha256: string, bytes = 12): Record<string, PinnedBinary> => ({
    t: {
      version: "1",
      env: "T_BIN",
      homeEnv: "T_HOME",
      platforms: { p: { path: "tool", url: "u1", sha256, bytes } },
    },
  });
  const o = (b: Record<string, PinnedBinary>) => ({ binaries: b, root: tmp, platform: "p" });
  const good = spec(sha256OfFile(file));
  expect(verifiedBinaryPath("t", o(good))).toBe(file);
  expect(verifiedBinaryPath("t", o(spec("0".repeat(64))))).toBeUndefined();
  expect(verifiedBinaryPath("t", o(spec(sha256OfFile(file), 13)))).toBeUndefined();
  expect(verifiedBinaryPath("t", { ...o(good), platform: "other" })).toBeUndefined();
  expect(verifiedBinaryPath("missing", o(good))).toBeUndefined();
  // Env: needs the run's scratch dir; home goes inside it.
  expect(pinnedBinaryEnv(["t"], undefined, o(good))).toEqual({ env: {}, paths: [] });
  expect(pinnedBinaryEnv(["t"], "/s", o(good))).toEqual({
    env: { T_BIN: file, T_HOME: "/s/t-home" },
    paths: [file],
  });
  chmodSync(file, 0o644); // not executable: the launcher would skip it and download instead
  writeFileSync(file, "engine bytez"); // new mtime: re-checked
  expect(verifiedBinaryPath("t", o(spec(sha256OfFile(file))))).toBeUndefined();
});

test("only the designer lists a pinned binary, and every listed name is pinned", () => {
  const listing = Object.values(ROLES).filter((r) => r.binaries?.length);
  expect(listing.map((r) => r.name)).toEqual(["designer"]);
  for (const r of listing)
    for (const n of r.binaries ?? []) expect(PINNED_BINARIES[n]).toBeDefined();
});

test("sandbox: a run's pinned binary is readable, never writable", () => {
  const bin = "/opt/pinned/tool";
  const sb = workerSandbox({
    writePaths: [tmp],
    binaryPaths: [bin],
    envelope: {
      goalId: "g",
      locations: [],
      goalDir: tmp,
      classes: ["R0"],
      effects: [],
      bounds: { maxItems: 1, maxBytes: 1 },
      grantedBy: "envelope",
    },
  });
  expect(sb?.filesystem?.allowRead).toContain(bin);
  expect(sb?.filesystem?.allowWrite ?? []).not.toContain(bin);
});

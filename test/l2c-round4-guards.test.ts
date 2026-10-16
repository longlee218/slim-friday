import { afterAll, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isChildEnvDenied, isWorkerEnvDenied } from "../src/config/child-env-deny";
import { checkToolCall, type GuardrailContext } from "../src/policy/check-tool-call";
import { defaultEnvelope } from "../src/policy/envelope";
import { carve, workerSandbox } from "../src/runtime/worker-sandbox";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(cleanupTmp);

/* Round-3 review fixes that outlive the shell policy (H3 H4 M3 M4 L3): file tools, sandbox settings, env scrub. */

const GIT = `${String.fromCharCode(46)}git`; // the git dir name (kept out of the source text)
const root = tmpRoot("round4-");
const loc = join(root, "loc");
const home = join(root, "home");
const scratch = join(home, "scratch");
const wt = join(root, "wt");
const out = join(root, "outside");
const skill = join(root, "skill");
for (const d of [join(loc, GIT), join(loc, "src"), home, scratch, wt, out, skill])
  mkdirSync(d, { recursive: true });
writeFileSync(join(out, "secret.txt"), "s");
writeFileSync(join(loc, "a.txt"), "x");
writeFileSync(join(loc, GIT, "config"), "url = https://u:tok@h/x");
symlinkSync(join(out, "secret.txt"), join(loc, "fl~")); // a file named like a rev suffix, linked outside
symlinkSync(join(loc, GIT), join(loc, "gitlnk"));

/** A worker context; `classes` picks the envelope's grant. */
const mk = (classes: string[] = ["R0", "R1"], extra: Partial<GuardrailContext> = {}) =>
  ({
    cwd: loc,
    writePaths: [loc, scratch],
    readPaths: [loc, scratch],
    denyPaths: [home],
    allowInside: [scratch, skill],
    skillDirs: [skill],
    worktreeDirs: [wt],
    shell: true,
    subagents: false,
    envelope: { ...defaultEnvelope("g", ["loc"], scratch), classes },
    ...extra,
  }) as GuardrailContext;

test("H3: a granted home dir is fully writable (dotfiles, git dir); a path outside every grant is still denied", () => {
  const h = homedir();
  const ctx = mk(["R0", "R1"], { cwd: h, writePaths: [h], readPaths: [h] });
  for (const f of [".zshrc", ".gitconfig", ".ssh/id_x", ".claude/settings.json"])
    expect([
      f,
      checkToolCall("Write", { file_path: join(h, f), content: "x" }, ctx).decision,
    ]).toEqual([f, "allow"]);
  // Outside every grant (the home's parent, /etc) nothing is written.
  expect(checkToolCall("Write", { file_path: "/etc/x", content: "x" }, ctx).decision).toBe("deny");
  // The sandbox: the home is a grant, so its credential dirs are no longer denied (the location wins); the agent home stays denied.
  const fs = (workerSandbox(ctx) as { filesystem: Record<string, string[]> }).filesystem;
  // A granted home is listed entry by entry around its sensitive files (a real home holds some: ~/.ssh/id_*, .env...).
  expect(fs.allowWrite.some((p) => p === h || p.startsWith(`${h}/`))).toBe(true);
  expect(fs.denyWrite ?? []).not.toContain(h); // only its sensitive entries are denied, never the home itself
  expect(fs.denyRead).not.toContain(join(h, ".ssh"));
  expect(fs.denyRead).toContain(home);
});

test("H4: the git dir of a location is writable by the file tools", () => {
  expect(
    checkToolCall("Write", { file_path: join(loc, GIT, "hooks", "x"), content: "x" }, mk())
      .decision,
  ).toBe("allow");
});

test("M3: reads are deny-by-default for the home; a granted home is listed child by child without its credential dirs", () => {
  const fake = join(root, "fakehome");
  for (const d of [".ssh", ".aws", "proj", ".config/gh", ".config/other"])
    mkdirSync(join(fake, d), { recursive: true });
  writeFileSync(join(fake, "notes.txt"), "x");
  const allowed = carve(fake, [
    join(fake, ".ssh"),
    join(fake, ".aws"),
    join(fake, ".config", "gh"),
  ]);
  expect(allowed).toEqual(
    expect.arrayContaining([
      join(fake, "proj"),
      join(fake, "notes.txt"),
      join(fake, ".config", "other"),
    ]),
  );
  for (const bad of [".ssh", ".aws", ".config/gh", ".config"])
    expect(allowed).not.toContain(join(fake, bad));
  expect(carve(loc, [join(out, "x")])).toEqual([loc]);
  const sb = (workerSandbox(mk()) as { filesystem: { denyRead: string[]; allowRead: string[] } })
    .filesystem;
  // A credential dir no grant covers stays denied.
  expect(sb.denyRead).toEqual(
    expect.arrayContaining([homedir(), join(homedir(), ".ssh"), join(homedir(), ".claude")]),
  );
  if (process.platform === "darwin") expect(sb.denyRead).toContain("/Users");
  expect(sb.allowRead).toContain(loc);
  expect(sb.allowRead).toContain(skill);
  expect(sb.allowRead).not.toContain(homedir());
});

test("M4: file tools of a worker read inside a git dir of its location (name, case, symlink, glob)", () => {
  const call = (name: string, input: Record<string, unknown>) =>
    checkToolCall(name, input, mk()).decision;
  expect(call("Read", { file_path: join(loc, GIT, "config") })).toBe("allow");
  expect(call("Read", { file_path: join(loc, GIT.toUpperCase(), "config") })).toBe("allow");
  expect(call("Read", { file_path: join(loc, "gitlnk", "config") })).toBe("allow");
  expect(call("Grep", { pattern: "url", path: join(loc, GIT) })).toBe("allow");
  expect(call("Glob", { pattern: `**/${GIT}/config`, path: loc })).toBe("allow");
  expect(call("Read", { file_path: join(out, "secret.txt") })).toBe("deny"); // outside every grant
});

test("L3: more secret-looking env names are dropped for a worker", () => {
  for (const k of [
    "DB_PWD",
    "STRIPE_APIKEY",
    "GH_AUTHTOKEN",
    "SENTRY_DSN",
    "DATABASE_URL",
    "PG_CONNECTION_STRING",
    "MY_PASSWORD",
  ])
    expect([k, isWorkerEnvDenied(k)]).toEqual([k, true]);
  expect(isWorkerEnvDenied("PWD")).toBe(isChildEnvDenied("PWD")); // the shell's own cwd stays
  expect(isWorkerEnvDenied("OLDPWD")).toBe(false);
});

import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerRepoArtifact } from "../src/artifacts/artifact-repo-ref";
import { searchArtifacts } from "../src/artifacts/artifact-search";
import { getArtifact } from "../src/storage/artifact-store";
import { makeEnv, outsideDir } from "./helpers";

/** A location dir with a doc, a secret file and a symlink out of it. */
function setup() {
  const env = makeEnv();
  const root = outsideDir();
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "keys"));
  writeFileSync(join(root, "docs", "plan.md"), "# Plan\nkế hoạch tuần");
  writeFileSync(join(root, ".env"), "TOKEN=1");
  writeFileSync(join(root, "keys", "a.md"), "secret");
  const outside = join(outsideDir(), "o.md");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(root, "docs", "link.md"));
  symlinkSync(join(root, ".env"), join(root, "docs", "env-link.md"));
  const input = (relPath: string) => ({
    workspace: "main",
    channel: "healthy",
    title: "Plan",
    kind: "md" as const,
    location: { name: "location", path: root },
    relPath,
    home: env.home,
  });
  return { ...env, input };
}

test("a file of the location is referenced (relative path, never copied) and indexed", () => {
  const { db, input } = setup();
  const r = registerRepoArtifact(db, input("docs/plan.md"));
  expect(r.path).toBe("docs/plan.md");
  expect(getArtifact(db, r.id)).toMatchObject({ origin: "repo", location: "location", size: 26 });
  expect(searchArtifacts(db, "main", { query: "ke hoach", limit: 5 }).hits).toHaveLength(1);
});

test("escape by .., absolute path and symlink out of the location are refused", () => {
  const { db, input } = setup();
  expect(() => registerRepoArtifact(db, input("../x.md"))).toThrow();
  expect(() => registerRepoArtifact(db, input("/etc/hosts"))).toThrow(/relative/);
  expect(() => registerRepoArtifact(db, input("docs/link.md"))).toThrow(/leaves the location/);
});

test("sensitive files and dirs are refused, also through a symlink; missing and dir targets too", () => {
  const { db, input } = setup();
  expect(() => registerRepoArtifact(db, input(".env"))).toThrow(/sensitive/);
  expect(() => registerRepoArtifact(db, input("keys/a.md"))).toThrow(/sensitive/);
  expect(() => registerRepoArtifact(db, input("docs/env-link.md"))).toThrow(/sensitive/);
  expect(() => registerRepoArtifact(db, input("docs/none.md"))).toThrow();
  expect(() => registerRepoArtifact(db, input("docs"))).toThrow(/not a file/);
  expect(db.query("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 0 });
});

test("the same title again is version 2 (reference rows are versioned too)", () => {
  const { db, input } = setup();
  registerRepoArtifact(db, input("docs/plan.md"));
  expect(registerRepoArtifact(db, input("docs/plan.md")).version).toBe(2);
});

test("a file of a project inside <home>/projects is referenced; other AGENT_HOME files stay refused", () => {
  const { db, home } = setup();
  const proj = join(home, "projects", "app");
  mkdirSync(join(proj, "docs"), { recursive: true });
  writeFileSync(join(proj, "docs", "ui.md"), "# UI");
  const input = (loc: string, relPath: string) => ({
    workspace: "main",
    channel: "healthy",
    kind: "md" as const,
    location: { name: "app", path: loc },
    relPath,
    home,
  });
  expect(registerRepoArtifact(db, input(proj, "docs/ui.md")).path).toBe("docs/ui.md");
  // A $HOME-like location around AGENT_HOME reaching the db or a persona file is still refused.
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "data", "x.md"), "db");
  expect(() =>
    registerRepoArtifact(db, input(join(home, ".."), `${home.split("/").pop()}/data/x.md`)),
  ).toThrow(/inside AGENT_HOME/);
  // The projects dir itself is not exempt.
  expect(() => registerRepoArtifact(db, input(join(home, "projects"), "app/docs/ui.md"))).toThrow(
    /inside AGENT_HOME/,
  );
});

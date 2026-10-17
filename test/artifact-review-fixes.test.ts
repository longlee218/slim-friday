import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ArtifactToolCtx, readArtifact } from "../src/artifacts/artifact-access";
import { REPORT_REPO_DOC_MAX_BYTES } from "../src/artifacts/artifact-limits";
import { resolveRefs } from "../src/artifacts/artifact-refs";
import { registerRepoArtifact } from "../src/artifacts/artifact-repo-ref";
import { writeArtifact } from "../src/artifacts/artifact-writer";
import { writeFileExclusive } from "../src/artifacts/safe-write";
import { workspacePaths } from "../src/config/workspace-paths";
import { makeEnv, outsideDir } from "./helpers";

/** A run ctx whose granted location is the PARENT of AGENT_HOME (a $HOME location) or a plain dir. */
function ctxOf(env: ReturnType<typeof makeEnv>, path: string): ArtifactToolCtx {
  const loc = { name: "location", path };
  return {
    db: env.db,
    home: env.home,
    workspace: "main",
    channel: "healthy",
    locations: [loc],
    granted: loc,
  };
}

const count = (db: ReturnType<typeof makeEnv>["db"]) =>
  (db.query("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n;

test("a $HOME-like location cannot reference a file inside AGENT_HOME, at register or on read", () => {
  const env = makeEnv();
  const parent = dirname(env.home);
  const rel = `${env.home.slice(parent.length + 1)}/note.md`;
  writeFileSync(join(env.home, "note.md"), "secret db-ish");
  const input = {
    workspace: "main",
    channel: "healthy",
    title: "Note",
    kind: "md" as const,
    location: { name: "location", path: parent },
    relPath: rel,
    home: env.home,
  };
  expect(() => registerRepoArtifact(env.db, input)).toThrow(/AGENT_HOME/);
});

test("a planted repo row that points into AGENT_HOME reads as metadata only", () => {
  const env = makeEnv();
  const parent = dirname(env.home);
  writeFileSync(join(env.home, "note.md"), "secret");
  const rel = `${env.home.slice(parent.length + 1)}/note.md`;
  env.db
    .query(
      `INSERT INTO artifacts (id, workspace, channel, title, name, kind, origin, path, location, version, size, created_at)
       VALUES ('a1','main','healthy','t','t.md','md','repo',?,'location',1,6,1)`,
    )
    .run(rel);
  const r = readArtifact(ctxOf(env, parent), "a1") as { text: string | null };
  expect(r.text).toBeNull();
});

test("a refused entry rolls back the others: no rows", () => {
  const env = makeEnv();
  const root = outsideDir();
  writeFileSync(join(root, "a.md"), "# a");
  const r = resolveRefs(ctxOf(env, root), [
    { title: "A", path: "a.md" },
    { title: "B", path: "missing.md" },
  ]);
  expect("errors" in r).toBe(true);
  expect(count(env.db)).toBe(0);
  const ok = resolveRefs(ctxOf(env, root), [{ title: "A", path: "a.md" }]);
  expect("ids" in ok && ok.ids).toHaveLength(1);
  expect(count(env.db)).toBe(1);
});

test("a repo file over the size limit is refused at register and read as metadata only", () => {
  const env = makeEnv();
  const root = outsideDir();
  writeFileSync(join(root, "big.md"), "x".repeat(REPORT_REPO_DOC_MAX_BYTES + 1));
  writeFileSync(join(root, "small.md"), "# small");
  const ctx = ctxOf(env, root);
  const r = resolveRefs(ctx, [{ title: "Big", path: "big.md" }]);
  expect("errors" in r && r.errors[0]).toMatch(/over/);
  const ok = resolveRefs(ctx, [{ title: "Small", path: "small.md" }]);
  const id = "ids" in ok ? ok.ids[0]! : "";
  writeFileSync(join(root, "small.md"), "x".repeat(REPORT_REPO_DOC_MAX_BYTES + 1));
  expect((readArtifact(ctx, id) as { text: string | null }).text).toBeNull();
});

test("two saves of one title never overwrite (exclusive publish, next version)", () => {
  const env = makeEnv();
  const a = { workspace: "main", channel: "healthy", kind: "md" as const, title: "Same" };
  const dir = workspacePaths(env.home).workspace("main").channel("healthy").artifacts;
  // The helper refuses a taken name and leaves no temp file.
  expect(writeFileExclusive(dir, "x.md", "1")).toBe(join(dir, "x.md"));
  expect(writeFileExclusive(dir, "x.md", "2")).toBeNull();
  // A stale db (version computed 1 while the file exists) still moves to v2.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "same.md"), "other save");
  const w = writeArtifact(env.db, env.home, { ...a, body: "mine" });
  expect(w.version).toBe(2);
  expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
});

test("the file name slug comes from the redacted title", () => {
  const env = makeEnv();
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const w = writeArtifact(env.db, env.home, {
    workspace: "main",
    channel: "healthy",
    kind: "md",
    title: `Report ${secret}`,
    body: "b",
  });
  expect(w.path).not.toContain("sk-ant");
});

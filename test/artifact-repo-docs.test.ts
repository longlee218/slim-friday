import { expect, test } from "bun:test";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ArtifactToolCtx, readArtifact, saveArtifact } from "../src/artifacts/artifact-access";
import { REPO_DOCS_DIR, repoDocsTarget } from "../src/artifacts/repo-docs";
import { taskStoreArtifacts } from "../src/storage/artifact-list-store";
import { getArtifact } from "../src/storage/artifact-store";
import { loadArtifactBody } from "../src/viewer/artifact-body";
import { makeEnv, outsideDir } from "./helpers";

/** A worker tool ctx in channel `healthy` of space `main`, with the given channel locations and granted one. */
const ctxOf = (
  env: ReturnType<typeof makeEnv>,
  locations: { name: string; path: string }[],
  granted?: { name: string; path: string },
): ArtifactToolCtx => ({
  db: env.db,
  home: env.home,
  workspace: "main",
  channel: "healthy",
  taskId: "task-1",
  locations,
  ...(granted && { granted }),
});

test("a run with a granted location saves into <location>/docs/friday; read, forward list and viewer serve it", () => {
  const env = makeEnv();
  const repo = { name: "app", path: outsideDir() };
  const c = ctxOf(env, [repo, { name: "other", path: outsideDir() }], repo);
  const saved = saveArtifact(c, { title: "Import guide", kind: "md", body: "# Guide\nsteps" });
  const row = getArtifact(env.db, saved.id)!;
  expect(row.path).toBe(join(realpathSync(repo.path), REPO_DOCS_DIR, "import-guide.md"));
  expect(row).toMatchObject({ origin: "store", location: "app" });
  expect((readArtifact(c, saved.id) as { text: string }).text).toContain("steps");
  expect(taskStoreArtifacts(env.db, "task-1").map((a) => a.path)).toEqual([row.path]);
  const roots = { home: env.home, locationPath: () => repo.path };
  expect(loadArtifactBody(row, roots)).toContain("steps");
  // The same name again is a new version next to the first file.
  const v2 = saveArtifact(c, { title: "Import guide", kind: "md", body: "new" });
  expect(getArtifact(env.db, v2.id)!.path).toEndWith("import-guide-v2.md");
});

test("no granted location: the channel's only location is used; several or none keep the AGENT_HOME store", () => {
  const env = makeEnv();
  const repo = { name: "app", path: outsideDir() };
  const one = saveArtifact(ctxOf(env, [repo]), { title: "A", kind: "md", body: "a" });
  expect(getArtifact(env.db, one.id)!.location).toBe("app");
  const two = saveArtifact(ctxOf(env, [repo, { name: "b", path: outsideDir() }]), {
    title: "B",
    kind: "md",
    body: "b",
  });
  const none = saveArtifact(ctxOf(env, []), { title: "C", kind: "md", body: "c" });
  for (const id of [two.id, none.id]) {
    const row = getArtifact(env.db, id)!;
    expect(row.location).toBeNull();
    expect(realpathSync(row.path).startsWith(realpathSync(env.home))).toBe(true);
  }
});

test("a $HOME location or a missing location dir is never a docs target", () => {
  expect(repoDocsTarget({ name: "home", path: homedir() }, [])).toBeUndefined();
  expect(repoDocsTarget(undefined, [{ name: "gone", path: join(outsideDir(), "nope") }])).toBe(
    undefined,
  );
});

test("a store row naming a location is served only from that location's docs/friday", () => {
  const env = makeEnv();
  const repo = { name: "app", path: outsideDir() };
  const saved = saveArtifact(ctxOf(env, [repo], repo), { title: "X", kind: "md", body: "x" });
  const row = getArtifact(env.db, saved.id)!;
  expect(statSync(row.path).isFile()).toBe(true);
  // The location now points elsewhere (or is unknown): the old file is outside its docs root and is not served.
  expect(loadArtifactBody(row, { home: env.home, locationPath: () => outsideDir() })).toBeNull();
  expect(loadArtifactBody(row, { home: env.home, locationPath: () => undefined })).toBeNull();
  const elsewhere = ctxOf(env, [{ name: "app", path: outsideDir() }]);
  expect((readArtifact(elsewhere, saved.id) as { text?: string | null }).text ?? null).toBeNull();
});

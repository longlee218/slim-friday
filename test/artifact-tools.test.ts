import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ArtifactToolCtx, readArtifact } from "../src/artifacts/artifact-access";
import { ARTIFACT_READ_PAGE_CHARS } from "../src/artifacts/artifact-limits";
import { searchArtifacts } from "../src/artifacts/artifact-search";
import { ARTIFACT_TOOLS } from "../src/mcp/artifacts/artifact-tool-names";
import { createListArtifactsTool } from "../src/mcp/artifacts/tools/ListArtifactsTool/list-artifacts-tool";
import { createReadArtifactTool } from "../src/mcp/artifacts/tools/ReadArtifactTool/read-artifact-tool";
import { createSaveArtifactTool } from "../src/mcp/artifacts/tools/SaveArtifactTool/save-artifact-tool";
import { createSearchArtifactsTool } from "../src/mcp/artifacts/tools/SearchArtifactsTool/search-artifacts-tool";
import { buildServers } from "../src/mcp/mcp-servers";
import { ARTIFACTS_MCP_SERVER, mcpToolName } from "../src/mcp/mcp-tool-names";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { ROLES } from "../src/roles/role-registry";
import { getArtifact } from "../src/storage/artifact-store";
import { makeEnv, outsideDir } from "./helpers";
import { FULL_CTX, toolsByServer } from "./mcp-ctx-fixture";
import { reportResultTool } from "./report-tool-helper";

/** A run ctx of the channel `healthy` of space `main`, with a granted location holding a doc, a secret and a symlink out. */
function setup(channel = "healthy") {
  const env = makeEnv();
  const root = outsideDir();
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "plan.md"), "# Plan\nv1 ke hoach");
  writeFileSync(join(root, ".env"), "TOKEN=1");
  const outside = join(outsideDir(), "o.md");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(root, "docs", "link.md"));
  const loc = { name: "location", path: root };
  const ctx = (over: Partial<ArtifactToolCtx> = {}): ArtifactToolCtx => ({
    db: env.db,
    home: env.home,
    workspace: "main",
    channel,
    role: "scout",
    locations: [loc],
    granted: loc,
    ...over,
  });
  return { ...env, root, ctx };
}

/** Call a tool handler and parse its JSON reply. */
// biome-ignore lint/suspicious/noExplicitAny: handler input differs per tool
async function call(t: { handler: (a: any, e: unknown) => Promise<any> }, args: object) {
  const r = await t.handler(args, {});
  return { isError: !!r.isError, ...JSON.parse(r.content[0].text) } as Record<string, any>;
}

test("SaveArtifact: no size cap, a same title is a new version, row stamped with the run", async () => {
  const { ctx, db } = setup();
  const save = createSaveArtifactTool(ctx({ goalId: "g1", taskId: "t1" }));
  const body = `# Big\n\n${"line of a long report\n\n".repeat(5000)}`; // ~110 KB
  const a = await call(save, { title: "Big report", kind: "md", body });
  expect(a.ok).toBe(true);
  expect(a.version).toBe(1);
  const b = await call(save, { title: "Big report", kind: "md", body: "second" });
  expect(b.version).toBe(2);
  expect(getArtifact(db, a.id)).toMatchObject({
    size: Buffer.byteLength(body),
    goalId: "g1",
    taskId: "t1",
    producerRole: "scout",
    channel: "healthy",
  });
});

test("scope: another channel's artifact is refused like an unknown id, in every tool", async () => {
  const { ctx } = setup();
  const mine = ctx();
  const other = ctx({ channel: "other" });
  const { id } = await call(createSaveArtifactTool(mine), {
    title: "Secret plan",
    kind: "md",
    body: "zebra",
  });
  expect((await call(createReadArtifactTool(mine), { id })).text).toBe("zebra");
  const refused = await call(createReadArtifactTool(other), { id });
  expect(refused).toMatchObject({ isError: true, code: "NOT_FOUND" });
  expect((await call(createReadArtifactTool(mine), { id: "nope" })).code).toBe("NOT_FOUND");
  expect((await call(createListArtifactsTool(other), {})).artifacts).toEqual([]);
  expect((await call(createSearchArtifactsTool(other), { query: "zebra" })).hits).toEqual([]);
  expect((await call(createListArtifactsTool(mine), {})).artifacts).toHaveLength(1);
});

test("ReadArtifact pages: any length readable, a page never exceeds the page size", async () => {
  const { ctx } = setup();
  const c = ctx();
  const text = "abcdefghij".repeat(2500); // 25000 chars
  const { id } = await call(createSaveArtifactTool(c), { title: "Pages", kind: "txt", body: text });
  const read = createReadArtifactTool(c);
  let offset = 0;
  let got = "";
  for (let i = 0; i < 10; i++) {
    const p = await call(read, { id, offset });
    expect(p.text.length).toBeLessThanOrEqual(ARTIFACT_READ_PAGE_CHARS);
    got += p.text;
    if (p.nextOffset === null) break;
    offset = p.nextOffset;
  }
  expect(got).toBe(text);
  expect((await call(read, { id, offset: 24990, limit: 5 })).nextOffset).toBe(24995);
  expect((await call(read, { id, offset: 99999 })).text).toBe("");
});

test("ReadArtifact: html gives metadata only", async () => {
  const { ctx } = setup();
  const c = ctx();
  const { id } = await call(createSaveArtifactTool(c), {
    title: "Page",
    kind: "html",
    body: "<p>x</p>",
  });
  const r = await call(createReadArtifactTool(c), { id });
  expect(r).toMatchObject({ ok: true, kind: "html", text: null });
});

test("SearchArtifacts finds by folded keywords; ListArtifacts newest first with filters", async () => {
  const { ctx } = setup();
  const c = ctx({ goalId: "g1" });
  const save = createSaveArtifactTool(c);
  await call(save, { title: "Giáo án", kind: "md", body: "giáo án tuần một" });
  await call(save, { title: "Other", kind: "md", body: "something else" });
  const s = await call(createSearchArtifactsTool(c), { query: "giao an" });
  expect(s.hits.map((h: { title: string }) => h.title)).toEqual(["Giáo án"]);
  expect(
    (await call(createSearchArtifactsTool(c), { query: "giao an", goalId: "zzz" })).hits,
  ).toEqual([]);
  expect((await call(createSearchArtifactsTool(c), { query: "!!!" })).code).toBe("INVALID_INPUT");
  const l = await call(createListArtifactsTool(c), {});
  expect(l.artifacts.map((a: { title: string }) => a.title)).toEqual(["Other", "Giáo án"]);
  expect((await call(createListArtifactsTool(c), { goalId: "none" })).artifacts).toEqual([]);
});

test("Report result refs: own ids and repo docs pass; escapes, secrets and foreign ids are refused", async () => {
  const { ctx } = setup();
  const c = ctx();
  const { id } = await call(createSaveArtifactTool(c), { title: "Rep", kind: "md", body: "x" });
  const foreign = await call(createSaveArtifactTool(ctx({ channel: "other" })), {
    title: "F",
    kind: "md",
    body: "y",
  });
  const report = (artifacts: object[]) => ({
    title: "T",
    status: "COMPLETED",
    summary: "s",
    artifacts,
  });
  const sink: { report?: unknown; artifactIds?: string[] } = {};
  const t = reportResultTool(sink as never, c);
  for (const bad of [
    { title: "x", path: "../outside.md" },
    { title: "x", path: "docs/link.md" },
    { title: "x", path: ".env" },
    { title: "x", path: "/etc/passwd" },
    { title: "x", path: "docs/missing.md" },
    { id: foreign.id },
  ]) {
    const r = await call(t, report([bad]));
    expect([bad, r.isError, r.code]).toEqual([bad, true, "INVALID_ARTIFACTS"]);
    expect(sink.report).toBeUndefined();
  }
  const ok = await call(t, report([{ id }, { title: "Plan doc", path: "docs/plan.md" }]));
  expect(ok.ok).toBe(true);
  expect(sink.artifactIds).toHaveLength(2);
  expect(getArtifact(c.db, sink.artifactIds![1]!)).toMatchObject({
    origin: "repo",
    path: "docs/plan.md",
    location: "location",
  });
  // A run without a granted location cannot report a repo doc.
  const none = reportResultTool({} as never, ctx({ granted: undefined }));
  expect((await call(none, report([{ title: "x", path: "docs/plan.md" }]))).code).toBe(
    "INVALID_ARTIFACTS",
  );
});

test("a repo artifact is re-indexed on read when its file changed; an unchanged one is not", async () => {
  const { ctx, root, db } = setup();
  const c = ctx();
  const sink: { artifactIds?: string[] } = {};
  await call(reportResultTool(sink as never, c), {
    title: "T",
    status: "COMPLETED",
    summary: "s",
    artifacts: [{ title: "Plan", path: "docs/plan.md" }],
  });
  const id = sink.artifactIds![0]!;
  const hits = (q: string) =>
    searchArtifacts(db, "main", { query: q, channel: "healthy", limit: 5 }).hits.length;
  expect(hits("hoach")).toBe(1);
  const file = join(root, "docs", "plan.md");
  writeFileSync(file, "# Plan\nv2 zebra");
  utimesSync(file, new Date(), new Date(Date.now() + 5000)); // an mtime the snapshot cannot equal
  const r = readArtifact(c, id) as { text: string };
  expect(r.text).toContain("zebra");
  expect(hits("zebra")).toBe(1);
  expect(hits("hoach")).toBe(0);
  expect(getArtifact(db, id)?.size).toBe(15);
  readArtifact(c, id); // same mtime again: no second index (still one row set)
  expect(hits("zebra")).toBe(1);
});

test("a repo artifact of a location the run lacks is metadata only", async () => {
  const { ctx } = setup();
  const sink: { artifactIds?: string[] } = {};
  await call(reportResultTool(sink as never, ctx()), {
    title: "T",
    status: "COMPLETED",
    summary: "s",
    artifacts: [{ title: "Plan", path: "docs/plan.md" }],
  });
  const r = readArtifact(ctx({ locations: [] }), sink.artifactIds![0]!);
  expect(r).toMatchObject({ ok: true, text: null });
});

test("the guard allows exactly the artifact tools of the role's mcpTools", () => {
  for (const role of Object.values(ROLES)) {
    const g = guardFor(role, {});
    for (const t of ARTIFACT_TOOLS) {
      const decision = checkToolCall(mcpToolName(ARTIFACTS_MCP_SERVER, t), {}, g).decision;
      expect([role.name, t, decision]).toEqual([
        role.name,
        t,
        role.mcpTools?.includes(t) ? "allow" : "deny",
      ]);
    }
  }
  for (const n of ["lead", "scout", "developer", "tester"])
    expect(ROLES[n]?.mcpTools).toEqual(expect.arrayContaining([...ARTIFACT_TOOLS]));
});

test("the artifacts server is built only with an artifacts ctx part", () => {
  const scout = ROLES.scout!;
  expect(toolsByServer(buildServers(scout, FULL_CTX))[ARTIFACTS_MCP_SERVER]).toHaveLength(4);
  expect(
    buildServers(scout, { ...FULL_CTX, artifacts: undefined })[ARTIFACTS_MCP_SERVER],
  ).toBeUndefined();
});

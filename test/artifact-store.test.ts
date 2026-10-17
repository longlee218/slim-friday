import { expect, test } from "bun:test";
import { chunkBody } from "../src/artifacts/artifact-chunks";
import { ARTIFACT_CHUNK_CHARS } from "../src/artifacts/artifact-limits";
import { searchArtifacts } from "../src/artifacts/artifact-search";
import { writeArtifact } from "../src/artifacts/artifact-writer";
import { makeEnv } from "./helpers";

const put = (
  env: ReturnType<typeof makeEnv>,
  over: Partial<Parameters<typeof writeArtifact>[2]> & { body: string },
) =>
  writeArtifact(env.db, env.home, {
    workspace: "main",
    channel: "healthy",
    kind: "md",
    title: "Giáo án 8 tuần",
    ...over,
  });

test("Vietnamese text is found with and without accents; the snippet keeps the original spelling", () => {
  const env = makeEnv();
  const { id } = put(env, { body: "# Giáo án\nTập luyện cho bé Kiều Seal: đứng quyết định." });
  for (const q of ["giáo án", "giao an", "GIAO AN", "quyet dinh", "dung"]) {
    const { hits } = searchArtifacts(env.db, "main", { query: q, limit: 5 });
    expect(hits.map((h) => h.artifactId)).toEqual([id]);
  }
  const hit = searchArtifacts(env.db, "main", { query: "giao an", limit: 5 }).hits[0]!;
  expect(hit.snippet).toContain("Giáo án");
  expect(hit.title).toBe("Giáo án 8 tuần");
});

test("search is scoped to the workspace and optionally the channel; operators cannot get in", () => {
  const env = makeEnv();
  put(env, { body: "alpha beta" });
  put(env, { channel: "work", title: "Other", body: "alpha gamma" });
  const q = (query: string, channel?: string) =>
    searchArtifacts(env.db, "main", { query, limit: 10, ...(channel && { channel }) }).hits;
  expect(q("alpha")).toHaveLength(2);
  expect(q("alpha", "work")).toHaveLength(1);
  expect(searchArtifacts(env.db, "other", { query: "alpha", limit: 10 }).hits).toHaveLength(0);
  expect(q('alpha" OR NOT * ^')).toHaveLength(2); // reduced to plain terms, no syntax error
  expect(searchArtifacts(env.db, "main", { query: "!!! ", limit: 5 }).terms).toBe(0);
});

test("html and diff are stored but not indexed; csv and txt are", () => {
  const env = makeEnv();
  put(env, { kind: "html", title: "H", body: "<p>zebra</p>" });
  put(env, { kind: "diff", title: "D", body: "+zebra" });
  put(env, { kind: "csv", title: "C", body: "a,b\nzebra,1" });
  put(env, { kind: "txt", title: "T", body: "zebra" });
  const kinds = searchArtifacts(env.db, "main", { query: "zebra", limit: 10 }).hits.map(
    (h) => h.kind,
  );
  expect(kinds.sort()).toEqual(["csv", "txt"]);
  expect(env.db.query("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 4 });
});

test("a long body is chunked, no size cap; one hit per artifact (its best chunk)", () => {
  const env = makeEnv();
  const para = (w: string) => `${w} ${"filler ".repeat(100)}`;
  const body = [...Array(40).keys()].map((i) => para(i === 30 ? "needle" : `p${i}`)).join("\n\n");
  put(env, { title: "Long", body });
  const n = env.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM artifacts_fts").get()!.n;
  expect(n).toBeGreaterThan(5);
  const { hits } = searchArtifacts(env.db, "main", { query: "needle filler", limit: 5 });
  expect(hits).toHaveLength(1);
});

test("chunkBody: paragraphs packed up to the limit, a long paragraph cut, blanks dropped", () => {
  expect(chunkBody("a\n\nb\n\n\n\n  \n\nc")).toEqual(["a\n\nb\n\nc"]);
  const long = chunkBody("x".repeat(ARTIFACT_CHUNK_CHARS * 2 + 5));
  expect(long.map((c) => c.length)).toEqual([ARTIFACT_CHUNK_CHARS, ARTIFACT_CHUNK_CHARS, 5]);
  expect(chunkBody("")).toEqual([]);
});

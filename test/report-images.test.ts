import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_IMAGE_MAX_BYTES } from "../src/artifacts/artifact-limits";
import type { TeammateThreadCtx } from "../src/orchestrator/teammate/teammate-runtime";
import { postReportImages } from "../src/orchestrator/worker/post-report-images";
import { checkReportImages } from "../src/orchestrator/worker/report-images";

/* A report sends screenshots to the owner once: only real image files inside the run's scratch dir. */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "shot-"));
  const scratchDir = join(dir, "task");
  mkdirSync(scratchDir);
  return { dir, scratchDir };
}

test("a png inside the scratch dir is accepted with its name and real path", () => {
  const { scratchDir } = scratch();
  const file = join(scratchDir, "home.png");
  writeFileSync(file, PNG);
  const r = checkReportImages([file], scratchDir);
  expect("images" in r && r.images.map((i) => i.name)).toEqual(["home.png"]);
});

test("a relative path (the Playwright server's ./page-<ts>.png) is read from the scratch dir", () => {
  const { scratchDir } = scratch();
  writeFileSync(join(scratchDir, "page-1.png"), PNG);
  const r = checkReportImages(["./page-1.png"], scratchDir);
  expect("images" in r && r.images.map((i) => i.name)).toEqual(["page-1.png"]);
  expect("errors" in checkReportImages(["../escape.png"], scratchDir)).toBe(true);
});

test("an https URL is accepted as a link (no scratch dir needed); http, other schemes and a huge URL are refused", () => {
  const r = checkReportImages(["https://cdn.example.com/shots/home.png?sig=1"], undefined);
  expect("images" in r && r.images).toEqual([
    { name: "home.png", url: "https://cdn.example.com/shots/home.png?sig=1" },
  ]);
  for (const bad of [
    "http://example.com/a.png",
    "https://example.com/" + "a".repeat(2000),
    "file:///etc/hosts",
  ])
    expect({ bad, refused: "errors" in checkReportImages([bad], undefined) }).toEqual({
      bad,
      refused: true,
    });
});

test("postReportImages sends a URL as a link and a file as an attachment", async () => {
  const { scratchDir } = scratch();
  const a = join(scratchDir, "a.png");
  writeFileSync(a, PNG);
  const sent: { text: string; image?: string }[] = [];
  const ctx = {
    message: {
      notify: async (text: string, opts?: { image?: { name: string } }) => {
        sent.push({ text, image: opts?.image?.name });
      },
    },
  } as unknown as TeammateThreadCtx;
  await postReportImages(ctx, [
    { name: "x.png", url: "https://cdn.example.com/x.png" },
    { name: "a.png", path: a },
  ]);
  expect(sent).toEqual([
    { text: "https://cdn.example.com/x.png", image: undefined },
    { text: "", image: "a.png" },
  ]);
});

test("refused: outside scratch, a symlink out of it, wrong extension, fake bytes, oversize, no scratch dir", () => {
  const { dir, scratchDir } = scratch();
  const outside = join(dir, "outside.png");
  writeFileSync(outside, PNG);
  const link = join(scratchDir, "link.png");
  symlinkSync(outside, link);
  const txt = join(scratchDir, "note.txt");
  writeFileSync(txt, PNG);
  const fake = join(scratchDir, "fake.png");
  writeFileSync(fake, "not an image at all");
  const big = join(scratchDir, "big.png");
  writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(REPORT_IMAGE_MAX_BYTES)]));
  for (const p of [outside, link, txt, fake, big, join(scratchDir, "missing.png")]) {
    const r = checkReportImages([p], scratchDir);
    expect({ p, refused: "errors" in r }).toEqual({ p, refused: true });
  }
  expect("errors" in checkReportImages([outside], undefined)).toBe(true);
});

test("postReportImages posts each file once as an attachment; a failing post is skipped, not thrown", async () => {
  const { scratchDir } = scratch();
  const a = join(scratchDir, "a.png");
  const b = join(scratchDir, "b.png");
  writeFileSync(a, PNG);
  writeFileSync(b, PNG);
  const posted: { name: string; size: number }[] = [];
  let calls = 0;
  const ctx = {
    message: {
      notify: async (_t: string, opts?: { image?: { name: string; bytes: Uint8Array } }) => {
        calls++;
        if (calls === 1) throw new Error("discord down");
        if (opts?.image) posted.push({ name: opts.image.name, size: opts.image.bytes.length });
      },
    },
  } as unknown as TeammateThreadCtx;
  await postReportImages(ctx, [
    { name: "a.png", path: a },
    { name: "b.png", path: b },
  ]);
  expect(posted).toEqual([{ name: "b.png", size: PNG.length }]);
});

test("Report result: a bad image refuses the report (not stored), a good one lands in the sink", async () => {
  const { REPORT_ACTIONS } = await import(
    "../src/mcp/orchestration/tools/ReportTool/report-actions"
  );
  const action = REPORT_ACTIONS.find((a) => a.name === "result");
  const { scratchDir } = scratch();
  const good = join(scratchDir, "ok.png");
  writeFileSync(good, PNG);
  const base = { title: "T", status: "COMPLETED", summary: "done" };
  const bad: { report?: unknown; images?: unknown } = {};
  const refused = await action?.run(
    { sink: bad, scratchDir } as never,
    { ...base, images: ["/etc/hosts"] } as never,
  );
  expect(refused).toMatchObject({ ok: false, code: "INVALID_IMAGES" });
  expect(bad.report).toBeUndefined();
  const ok: { report?: unknown; images?: { name: string }[] } = {};
  await action?.run({ sink: ok, scratchDir } as never, { ...base, images: [good] } as never);
  expect(ok.images?.map((i) => i.name)).toEqual(["ok.png"]);
  expect(ok.report).toBeDefined();
});

import { expect, test } from "vitest";
import config from "../vite.config";

type ChunkName = (chunk: { moduleIds: string[] }) => string;

async function chunkName(): Promise<ChunkName> {
  const resolved = await (config as (env: object) => Promise<{ build: never }> | { build: never })({
    mode: "test",
    command: "build",
  });
  const build = resolved.build as {
    rolldownOptions: { output: { chunkFileNames: ChunkName } };
  };
  return build.rolldownOptions.output.chunkFileNames;
}

const SRC = "/repo/apps/web/src/components/files";

test("the PDF viewer chunk goes under assets/lazy/ so it is never precached", async () => {
  const name = await chunkName();
  expect(
    name({ moduleIds: [`${SRC}/pdf-viewer.tsx`, "/repo/node_modules/react-pdf/dist/Page.js"] }),
  ).toMatch(/^assets\/lazy\//);
  expect(name({ moduleIds: ["/repo/node_modules/pdfjs-dist/build/pdf.mjs"] })).toMatch(
    /^assets\/lazy\//,
  );
});

test("other app chunks stay in assets/", async () => {
  const name = await chunkName();
  expect(name({ moduleIds: [`${SRC}/file-preview.tsx`] })).toMatch(/^assets\/\[name\]/);
});

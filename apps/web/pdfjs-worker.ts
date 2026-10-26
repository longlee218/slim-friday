import { createRequire } from "node:module";

// pdfjs-dist is react-pdf's own dependency and is not installed at the top of apps/web, so the
// worker file is resolved from react-pdf's location. The app imports it as `pdfjs-worker?url`
// (see src/components/files/pdf-viewer.tsx) so the build emits it as a same-origin asset.
const fromReactPdf = createRequire(createRequire(import.meta.url).resolve("react-pdf"));

export const pdfjsWorkerAlias = [
  {
    find: /^pdfjs-worker(\?.*)?$/,
    replacement: `${fromReactPdf.resolve("pdfjs-dist/build/pdf.worker.min.mjs")}$1`,
  },
];

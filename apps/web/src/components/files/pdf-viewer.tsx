// Alias of pdfjs-dist/build/pdf.worker.min.mjs (see pdfjs-worker.ts); `?url` emits it as an asset.
import workerUrl from "pdfjs-worker?url";
import { ChevronLeft, ChevronRight, Download, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { Button, IconButton } from "../ui/button";

// The worker is a same-origin asset (worker-src 'self'); it must be set in the module that
// renders <Document>.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// The CSP has no 'unsafe-eval'. The option is not in pdfjs-dist's typings, hence the widening.
const OPTIONS: object = { isEvalSupported: false };
const MAX_WIDTH = 900;

export interface PdfViewerProps {
  url: string;
  name: string;
  onDownload(): void;
}

/**
 * One page at a time with previous/next and a page count. A corrupt, password-protected or
 * unreachable PDF shows an error line; Download works in every state.
 */
export default function PdfViewer({ url, name, onDownload }: PdfViewerProps) {
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const width = Math.min(MAX_WIDTH, window.innerWidth - 32);
  return (
    <>
      <div className="vw-stage pdf-stage">
        {error ? (
          <p className="vw-msg">{error}</p>
        ) : (
          <Document
            file={url}
            options={OPTIONS}
            loading={<LoaderCircle className="spin vw-msg" aria-label="Loading" />}
            onLoadSuccess={(pdf) => setPages(pdf.numPages)}
            onLoadError={() => setError("Could not open this PDF.")}
            onPassword={() => setError("This PDF is password protected.")}
          >
            <Page
              pageNumber={page}
              width={width}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              onRenderError={() => setError("Could not show this page.")}
            />
          </Document>
        )}
      </div>
      <nav className="vw-pdfbar" aria-label={`${name} pages`}>
        {pages > 0 && !error && (
          <>
            <IconButton
              label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft size={18} strokeWidth={1.75} />
            </IconButton>
            <span className="vw-count num">{`${page} / ${pages}`}</span>
            <IconButton
              label="Next page"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={18} strokeWidth={1.75} />
            </IconButton>
          </>
        )}
        <Button onClick={onDownload}>
          <Download size={14} strokeWidth={1.75} />
          Download
        </Button>
      </nav>
    </>
  );
}

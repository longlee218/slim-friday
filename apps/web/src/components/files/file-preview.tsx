import { Dialog } from "@base-ui/react/dialog";
import type { FileDto } from "@friday/contracts";
import { Download, LoaderCircle, X } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { formatSize } from "../../lib/format";
import { useDownloadFile } from "../chat/use-download-file";
import { useFileUrlState } from "../chat/use-file-url";
import { Button, IconButton } from "../ui/button";

// Loaded on first use so pdf.js stays out of the main bundle.
const PdfViewer = lazy(() => import("./pdf-viewer"));

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** How a file opens in the app. Decided by MIME type, never by file name. */
export function previewKind(file: { mimeType: string }): "image" | "pdf" | "other" {
  if (IMAGE_TYPES.has(file.mimeType)) return "image";
  return file.mimeType === "application/pdf" ? "pdf" : "other";
}

/** Full-window PDF preview; `onClose` fires after the fade-out, like `ImageViewer`. */
export function FilePreview({ file, onClose }: { file: FileDto; onClose(): void }) {
  const [open, setOpen] = useState(true);
  const { url, failed } = useFileUrlState(file.id);
  const download = useDownloadFile();
  const onDownload = () => void download(file);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup className="viewer">
          <Dialog.Title className="sr-only">{file.name}</Dialog.Title>
          <div className="vw-top">
            <span className="grow">
              <b>{file.name}</b>
              <span>{formatSize(file.size)}</span>
            </span>
            <IconButton label="Close" onClick={() => setOpen(false)}>
              <X size={16} strokeWidth={1.75} />
            </IconButton>
          </div>
          {url ? (
            <Suspense fallback={<LoaderCircle className="spin vw-msg" aria-label="Loading" />}>
              <PdfViewer url={url} name={file.name} onDownload={onDownload} />
            </Suspense>
          ) : (
            <>
              <div className="vw-stage">
                {failed ? (
                  <p className="vw-msg">Could not load this PDF.</p>
                ) : (
                  <LoaderCircle className="spin vw-msg" aria-label="Loading" />
                )}
              </div>
              {failed && (
                <div className="vw-pdfbar">
                  <Button onClick={onDownload}>
                    <Download size={14} strokeWidth={1.75} />
                    Download
                  </Button>
                </div>
              )}
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

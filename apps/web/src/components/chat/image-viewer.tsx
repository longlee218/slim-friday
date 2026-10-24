import { Dialog } from "@base-ui/react/dialog";
import type { FileDto } from "@friday/contracts";
import { ChevronLeft, ChevronRight, Download, LoaderCircle, X } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import { formatClock, formatSize } from "../../lib/format";
import { Avatar } from "../ui/avatar";
import { IconButton } from "../ui/button";
import { useBotFace } from "./use-bot-face";
import { useFileUrlState } from "./use-file-url";

export interface ImageViewerProps {
  files: FileDto[];
  /** Index of the image shown first. */
  index: number;
  botName: string;
  /** Gives the top bar its avatar; the default face shows without it. */
  botId?: string;
  at: number;
  onClose(): void;
}

/** The picture itself with its loading and failed states; remounted per file via `key`. */
function Stage({ file }: { file: FileDto }) {
  const { url, failed } = useFileUrlState(file.id);
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  if (failed || state === "failed") return <p className="vw-msg">Could not load this image.</p>;
  return (
    <>
      {state === "loading" && <LoaderCircle className="spin vw-msg" aria-label="Loading" />}
      {url && (
        <img
          src={url}
          alt={file.name}
          hidden={state === "loading"}
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      )}
    </>
  );
}

/**
 * Full-window viewer. Base UI Dialog gives the focus trap, Escape and focus return to the
 * opening thumbnail; arrow keys are bound on the document only while it is open.
 * `onClose` fires after the 200 ms fade-out has finished.
 */
export function ImageViewer({ files, index, botName, botId, at, onClose }: ImageViewerProps) {
  const [open, setOpen] = useState(true);
  const [i, setI] = useState(index);
  const file = files[i] as FileDto;
  const bot = useBotFace(botId);
  const { url } = useFileUrlState(file.id);
  // Arrow keys listen on the document only while the viewer is open (not during the fade-out),
  // so they work wherever focus sits inside the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
      if (e.key === "ArrowRight") setI((n) => Math.min(files.length - 1, n + 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, files.length]);
  const step = (n: number) => files[i + n] && setI(i + n);
  // A click on the dark area (not on the image or a button) closes.
  const onBackdropClick = (e: MouseEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    if (el === e.currentTarget || el.classList.contains("vw-stage")) setOpen(false);
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup className="viewer" onClick={onBackdropClick}>
          <Dialog.Title className="sr-only">{file.name}</Dialog.Title>
          <div className="vw-top">
            <span className="grow">
              <Avatar src={bot.src} name={botName} size={22} />
              <b>{file.name}</b>
              <span>{`${formatSize(file.size)} · ${botName} · ${formatClock(at, Date.now())}`}</span>
            </span>
            {url ? (
              <a
                className="ib"
                href={url}
                download={file.name}
                rel="noopener"
                aria-label="Download"
              >
                <Download size={16} strokeWidth={1.75} />
              </a>
            ) : (
              <IconButton label="Download" disabled>
                <Download size={16} strokeWidth={1.75} />
              </IconButton>
            )}
            <IconButton label="Close" onClick={() => setOpen(false)}>
              <X size={16} strokeWidth={1.75} />
            </IconButton>
          </div>
          <div className="vw-stage">
            {files.length > 1 && (
              <IconButton
                label="Previous"
                className="vw-nav"
                disabled={i === 0}
                onClick={() => step(-1)}
              >
                <ChevronLeft size={20} strokeWidth={1.75} />
              </IconButton>
            )}
            <Stage key={file.id} file={file} />
            {files.length > 1 && (
              <IconButton
                label="Next"
                className="vw-nav"
                disabled={i === files.length - 1}
                onClick={() => step(1)}
              >
                <ChevronRight size={20} strokeWidth={1.75} />
              </IconButton>
            )}
          </div>
          {files.length > 1 && <div className="vw-count num">{`${i + 1} / ${files.length}`}</div>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { AnimatePresence, motion } from "motion/react";
import type { Attachment } from "../chat/chat-types";
import { Icon } from "../ui/icon";
import { fileExt, formatBytes } from "./message-snippet";

/** Thin bar over an attachment while it uploads; fades out when done. */
function UploadBar({ on }: { on?: boolean }) {
  return (
    <AnimatePresence>
      {on && (
        <motion.span
          className="upload-bar"
          role="progressbar"
          aria-label="Uploading"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.3 } }}
        >
          <i />
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/**
 * Photos in a message: one keeps its own shape, two sit side by side,
 * three or more fill a 2-column grid; past four, the last cell shows "+N".
 * Each photo shares a layoutId with the lightbox so it zooms open from here.
 */
export function ImageGrid({ images, onOpen }: { images: Attachment[]; onOpen(id: string): void }) {
  const shown = images.slice(0, 4);
  const extra = images.length - shown.length;
  return (
    <div className="images" data-count={shown.length}>
      {shown.map((a, i) => (
        <button key={a.id} type="button" className="images__cell" onClick={() => onOpen(a.id)} aria-label={`Open ${a.name}`}>
          <motion.img layoutId={`img-${a.id}`} src={a.url} alt={a.name} draggable={false} data-uploading={a.uploading || undefined} />
          {i === shown.length - 1 && extra > 0 && <span className="images__more">+{extra}</span>}
          <UploadBar on={a.uploading} />
        </button>
      ))}
    </div>
  );
}

/** One file: extension tile, name, size, download. Used for sent files and teammate files. */
export function FileTile({ name, size, url, uploading }: { name: string; size: number; url?: string; uploading?: boolean }) {
  return (
    <div className="file" data-uploading={uploading || undefined}>
      <span className="file__ext" aria-hidden="true">
        {fileExt(name)}
      </span>
      <span className="file__text">
        <b>{name}</b>
        <span>{uploading ? "Uploading" : formatBytes(size)}</span>
      </span>
      {!uploading &&
        (url ? (
          <a className="tool" href={url} download={name} aria-label={`Download ${name}`}>
            <Icon name="download" />
          </a>
        ) : (
          <button type="button" className="tool" aria-label={`Download ${name}`}>
            <Icon name="download" />
          </button>
        ))}
      <UploadBar on={uploading} />
    </div>
  );
}

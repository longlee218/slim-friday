import type { FileDto, MessageDto } from "@friday/contracts";
import { useState } from "react";
import { ImageViewer } from "./image-viewer";
import { useBotFace } from "./use-bot-face";
import { useFileUrl } from "./use-file-url";

/** Grid class by image count: one large, two side by side, 1 + 2 stacked, else two columns. */
export function galleryClass(count: number): string {
  return `n${Math.min(count, 4)}`;
}

/** One thumbnail button; the image keeps its own ratio when the engine knows it. */
function Shot({ file, own, onOpen }: { file: FileDto; own: boolean; onOpen(): void }) {
  const url = useFileUrl(file.id);
  const ratio = own && file.width && file.height ? `${file.width} / ${file.height}` : undefined;
  return (
    <button type="button" className="shot" aria-label={`Open ${file.name}`} onClick={onOpen}>
      {url ? (
        <img
          src={url}
          alt={file.name}
          loading="lazy"
          style={ratio ? { aspectRatio: ratio } : undefined}
        />
      ) : (
        <span className="shot-wait" style={ratio ? { aspectRatio: ratio } : undefined} />
      )}
    </button>
  );
}

/** A bot's images as a gallery; each thumbnail opens the viewer at that image. */
export function ImageGallery({ files, message }: { files: FileDto[]; message: MessageDto }) {
  const [open, setOpen] = useState<number | null>(null);
  const botId = message.author.kind === "bot" ? message.author.botId : undefined;
  const bot = useBotFace(botId);
  return (
    <>
      <div className={`gallery ${galleryClass(files.length)}`}>
        {files.map((f, i) => (
          <Shot key={f.id} file={f} own={files.length === 1} onOpen={() => setOpen(i)} />
        ))}
      </div>
      {open !== null && (
        <ImageViewer
          files={files}
          index={open}
          botName={bot.name}
          botId={botId}
          at={message.at}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

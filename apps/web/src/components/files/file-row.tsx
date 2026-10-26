import type { FileLibraryItemDto } from "@friday/contracts";
import { FileText, Image } from "lucide-react";
import { fileTypeLabel, formatClock, formatSize } from "../../lib/format";

/** One uploaded file: type tile, name, "<size> · <type>" and when it was sent. */
export function FileRow({
  file,
  onOpen,
}: {
  file: FileLibraryItemDto;
  onOpen(file: FileLibraryItemDto): void;
}) {
  const Icon = file.kind === "image" ? Image : FileText;
  return (
    <button type="button" className="file-row" onClick={() => onOpen(file)}>
      <span className="fi">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <span className="grow">
        <span className="fn">{file.name}</span>
        <span className="fs">{`${formatSize(file.size)} · ${fileTypeLabel(file.mimeType, file.name)}`}</span>
      </span>
      <span className="fs">{formatClock(file.at, Date.now())}</span>
    </button>
  );
}

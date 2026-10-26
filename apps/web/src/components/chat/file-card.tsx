import type { FileDto } from "@friday/contracts";
import { Download, FileText, Image } from "lucide-react";
import { fileTypeLabel, formatSize } from "../../lib/format";
import { IconButton } from "../ui/button";
import { useDownloadFile } from "./use-download-file";

/** A file the bot attached: type tile, name, "<size> · <type>" and a Download button. */
export function FileCard({ file }: { file: FileDto }) {
  const download = useDownloadFile();
  const Icon = file.kind === "image" ? Image : FileText;
  return (
    <div className="file">
      <span className="fi">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <div className="grow">
        <div className="fn">{file.name}</div>
        <div className="fs">{`${formatSize(file.size)} · ${fileTypeLabel(file.mimeType, file.name)}`}</div>
      </div>
      <IconButton label="Download" onClick={() => download(file)}>
        <Download size={16} strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}

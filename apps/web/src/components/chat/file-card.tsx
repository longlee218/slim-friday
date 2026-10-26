import type { FileDto } from "@friday/contracts";
import { Download, FileText, Image } from "lucide-react";
import { useState } from "react";
import { fileTypeLabel, formatSize } from "../../lib/format";
import { FilePreview, previewKind } from "../files/file-preview";
import { IconButton } from "../ui/button";
import { useDownloadFile } from "./use-download-file";

/**
 * A file the bot attached: type tile, name, "<size> · <type>" and a Download button. A PDF's
 * name opens the in-app preview.
 */
export function FileCard({ file }: { file: FileDto }) {
  const download = useDownloadFile();
  const [preview, setPreview] = useState(false);
  const Icon = file.kind === "image" ? Image : FileText;
  const text = (
    <>
      <div className="fn">{file.name}</div>
      <div className="fs">{`${formatSize(file.size)} · ${fileTypeLabel(file.mimeType, file.name)}`}</div>
    </>
  );
  return (
    <div className="file">
      <span className="fi">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      {previewKind(file) === "pdf" ? (
        <button
          type="button"
          className="grow fpreview"
          aria-label={`Preview ${file.name}`}
          onClick={() => setPreview(true)}
        >
          {text}
        </button>
      ) : (
        <div className="grow">{text}</div>
      )}
      <IconButton label="Download" onClick={() => download(file)}>
        <Download size={16} strokeWidth={1.75} />
      </IconButton>
      {preview && <FilePreview file={file} onClose={() => setPreview(false)} />}
    </div>
  );
}

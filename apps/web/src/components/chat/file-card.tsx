import type { FileDto } from "@friday/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Image } from "lucide-react";
import { toast } from "sonner";
import { orpc } from "../../api/client";
import { fileTypeLabel, formatSize } from "../../lib/format";
import { IconButton } from "../ui/button";

/** A file the bot attached: type tile, name, "<size> · <type>" and a Download button. */
export function FileCard({ file }: { file: FileDto }) {
  const qc = useQueryClient();
  // The URL is fetched on click (non-image URLs carry `dl=`), so cards cost nothing until used.
  const download = async () => {
    try {
      const { url } = await qc.fetchQuery({
        ...orpc.chat.file.queryOptions({ input: { id: file.id } }),
        staleTime: 10 * 60 * 1000,
      });
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.rel = "noopener";
      a.click();
    } catch {
      toast("Could not download this file. Try again.");
    }
  };
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
      <IconButton label="Download" onClick={download}>
        <Download size={16} strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}

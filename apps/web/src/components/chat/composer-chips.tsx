import { X } from "lucide-react";
import { IconButton } from "../ui/button";
import type { UploadChip } from "./use-uploads";

/** The attached files above the text: name, progress or failure note, and a remove button. */
export function ComposerChips({
  uploads,
  onRemove,
}: {
  uploads: UploadChip[];
  onRemove(id: string): void;
}) {
  if (!uploads.length) return null;
  return (
    <div className="chips">
      {uploads.map((u) => (
        <span key={u.id} className={u.state === "failed" ? "chip failed" : "chip"}>
          {u.name}
          {u.state === "uploading" && <span className="note">Uploading…</span>}
          {u.state === "failed" && <span className="note">{u.error}</span>}
          <IconButton label={`Remove ${u.name}`} onClick={() => onRemove(u.id)}>
            <X size={12} strokeWidth={1.75} />
          </IconButton>
        </span>
      ))}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE } from "../chat/attachment-limits";
import type { Attachment } from "../chat/chat-types";
import { formatBytes } from "./message-snippet";

const uid = () => Math.random().toString(36).slice(2, 10);
/** How long a "skipped files" notice stays, ms. */
const NOTICE_MS = 4500;

/** Turn picked, pasted or dropped files into attachments with a local object URL for preview. */
function toAttachment(file: File): Attachment {
  return {
    id: uid(),
    type: file.type.startsWith("image/") ? "image" : "file",
    name: file.name || "Pasted image",
    size: file.size,
    url: URL.createObjectURL(file),
    uploading: true,
  };
}

/**
 * Files waiting in the composer before send. Files over the size limit or past the
 * count limit are skipped with a short notice. Removing one frees its preview URL;
 * after send the URLs stay alive because the sent message still shows them.
 */
export function useDraftAttachments() {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);

  const add = useCallback(
    (list: FileList | File[]) => {
      const all = Array.from(list);
      const tooBig = all.filter((f) => f.size > MAX_FILE_BYTES);
      const fit = all.filter((f) => f.size <= MAX_FILE_BYTES);
      const taken = fit.slice(0, Math.max(0, MAX_FILES_PER_MESSAGE - files.length));
      if (taken.length) setFiles((cur) => [...cur, ...taken.map(toAttachment)]);

      const skipped: string[] = [];
      if (tooBig.length) {
        const what = tooBig.length === 1 ? tooBig[0].name : `${tooBig.length} files`;
        skipped.push(`${what} is over ${formatBytes(MAX_FILE_BYTES)}`);
      }
      if (fit.length > taken.length) skipped.push(`a message holds ${MAX_FILES_PER_MESSAGE} files at most`);
      setNotice(skipped.length ? `Not added: ${skipped.join("; ")}.` : null);
    },
    [files.length],
  );
  const remove = useCallback((id: string) => {
    setFiles((cur) => {
      const gone = cur.find((a) => a.id === id);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return cur.filter((a) => a.id !== id);
    });
  }, []);
  /** Hand the drafts to a sent message and empty the tray. */
  const take = useCallback(() => {
    const out = files;
    setFiles([]);
    setNotice(null);
    return out;
  }, [files]);
  return { files, notice, add, remove, take };
}

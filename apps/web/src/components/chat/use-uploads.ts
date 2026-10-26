import { acceptedMimeForName } from "@friday/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api/client";
import { checkFiles } from "./composer-rules";

/** One file chip in the composer. */
export interface UploadChip {
  /** Local id (the chip's key). */
  id: string;
  /** Server upload id, set once the PUT succeeded; this is what `chat.send` takes. */
  uploadId?: string;
  name: string;
  size: number;
  state: "uploading" | "done" | "failed";
  error?: string;
}

const FAILED = "Upload failed. Try again.";

/**
 * File chips of one conversation's composer. Each file: refuse locally (no network), ask
 * `chat.uploadCreate` for a presigned URL, then PUT the bytes straight to storage. The PUT is
 * a plain fetch without credentials (the URL is not our origin; no cookie may go there).
 * In-flight PUTs are aborted on remove, clear and unmount.
 */
export function useUploads(conversationId: string) {
  const [uploads, setUploads] = useState<UploadChip[]>([]);
  // Mirror for the synchronous count check in `add`.
  const count = useRef(0);
  count.current = uploads.length;
  const aborts = useRef(new Map<string, AbortController>());

  const patch = useCallback((id: string, p: Partial<UploadChip>) => {
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...p } : u)));
  }, []);

  const run = useCallback(
    async (chip: UploadChip, file: File, ctl: AbortController) => {
      const type = file.type || "application/octet-stream";
      try {
        const ticket = await client.chat.uploadCreate({
          conversationId,
          name: file.name,
          type,
          size: file.size,
        });
        const res = await fetch(ticket.putUrl, {
          method: "PUT",
          body: file,
          // The URL signs the type the server derived from the name, not the browser's.
          headers: { "Content-Type": acceptedMimeForName(file.name) ?? type },
          credentials: "omit",
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error("put");
        patch(chip.id, { state: "done", uploadId: ticket.uploadId });
      } catch {
        if (!ctl.signal.aborted) patch(chip.id, { state: "failed", error: FAILED });
      } finally {
        aborts.current.delete(chip.id);
      }
    },
    [conversationId, patch],
  );

  /** Starts the uploads; returns the refusal text (nothing started) or null. */
  const add = useCallback(
    (files: File[]): string | null => {
      const check = checkFiles(count.current, files);
      if (!check.ok) return check.error;
      const chips = files.map((f) => ({
        id: crypto.randomUUID(),
        name: f.name,
        size: f.size,
        state: "uploading" as const,
      }));
      count.current += chips.length;
      setUploads((list) => [...list, ...chips]);
      chips.forEach((chip, i) => {
        const ctl = new AbortController();
        aborts.current.set(chip.id, ctl);
        void run(chip, files[i] as File, ctl);
      });
      return null;
    },
    [run],
  );

  const remove = useCallback((id: string) => {
    aborts.current.get(id)?.abort();
    aborts.current.delete(id);
    setUploads((list) => list.filter((u) => u.id !== id));
  }, []);

  const clear = useCallback(() => {
    for (const c of aborts.current.values()) c.abort();
    aborts.current.clear();
    setUploads([]);
  }, []);

  // Leaving the composer or switching conversation cancels whatever is still uploading and
  // empties the chips (their uploads belong to the old conversation).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the conversation changes
  useEffect(() => {
    const map = aborts.current;
    return () => {
      for (const c of map.values()) c.abort();
      map.clear();
      setUploads([]);
    };
  }, [conversationId]);

  return { uploads, add, remove, clear };
}

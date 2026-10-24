import type { Attachment, FileRef, InboundMessage } from "@friday/core";
import { openInboxDir, writeInboxFile } from "./inbound-inbox";
import { safeName } from "./safe-name";
import { SurfaceError } from "./surface-error";
import type { WebSurfaceDeps } from "./web-surface";

/** The message fields a replay hands over again (text, reply and nonce of the retry). */
type ReplayBase = Omit<InboundMessage, "files" | "attachments">;

/**
 * Hand a stored message (found by its `clientNonce`) to the handler again, as the first send had it. The
 * first send may have died after the append and before the uploads were marked used or the run was made:
 * the retry's uploads whose key a file of the stored message holds are marked used (so the upload sweeper
 * keeps their objects), and the attachments are rebuilt from the stored files into a new inbox directory
 * (so a run made by this replay gets them). A file whose object cannot be read is left out and logged.
 */
export async function replayStored(
  deps: WebSurfaceDeps,
  handler: (m: InboundMessage) => Promise<number | undefined>,
  base: ReplayBase,
  storedId: number,
  uploadIds: string[],
): Promise<{ messageId: number }> {
  const { store } = deps;
  const files: FileRef[] = (await store.messages.get(storedId))?.files ?? [];
  const rows = [];
  for (const f of files) {
    const row = await store.files.get(f.fileId);
    if (row) rows.push(row);
  }
  const keys = new Set(rows.map((r) => r.key));
  for (const id of uploadIds) {
    const u = await store.uploads.get(id);
    if (u && u.conversationId === base.conversationId && u.state !== "used" && keys.has(u.key))
      await store.uploads.markUsed(u.id, storedId);
  }
  const dir = await openInboxDir(
    deps.inboxDir,
    base.conversationId,
    deps.clock.now(),
    rows.length > 0,
  );
  const attachments: Attachment[] = [];
  for (const [idx, r] of rows.entries()) {
    try {
      const bytes = await deps.files.read(r.key);
      const { name, path } = await writeInboxFile(dir, idx, safeName(r.name), bytes);
      attachments.push({ name, mimeType: r.mimeType, path, size: bytes.length });
    } catch (err) {
      deps.log?.warn(
        { fileId: r.id, error: err instanceof Error ? err.message : String(err) },
        "web.replay_file_unreadable",
      );
    }
  }
  const id = await handler({ ...base, files, attachments });
  if (id === undefined) throw new SurfaceError("NOT_FOUND", "conversation not found");
  return { messageId: id };
}

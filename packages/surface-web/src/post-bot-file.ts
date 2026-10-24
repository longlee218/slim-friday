import { randomUUID } from "node:crypto";
import {
  type Author,
  type Clock,
  type ConversationId,
  type FileStore,
  type Log,
  postStored,
  type Store,
  type Surface,
} from "@friday/core";
import { imageType } from "./image-type";
import { toFileRef } from "./message-dto";
import { safeName } from "./safe-name";
import { sizeOf } from "./size-of";

/** What posting a bot file needs. */
export interface PostBotFileDeps {
  store: Pick<Store, "messages" | "files">;
  files: FileStore;
  clock: Clock;
  surface: Surface;
  log?: Log;
}

/**
 * Put a bot's file on the file store, record it, then post a `file` message that carries it.
 * A store failure rejects before anything is recorded.
 */
export async function postBotFile(
  deps: PostBotFileDeps,
  conversationId: ConversationId,
  author: Author,
  file: { path: string; name: string },
  caption?: string,
): Promise<void> {
  const handle = Bun.file(file.path);
  const bytes = await handle.bytes();
  const fileId = randomUUID();
  const name = safeName(file.name);
  const key = `files/${conversationId}/${fileId}/${name}`;
  const image = imageType(bytes);
  const mimeType = image ?? (handle.type || "application/octet-stream");
  const dims = image ? sizeOf(bytes) : undefined;
  const fail = (e: unknown): Error => {
    deps.log?.warn({ conversationId }, "bot file post failed");
    return new Error(`Could not store the file: ${e instanceof Error ? e.message : String(e)}`);
  };
  try {
    await deps.files.put(key, bytes, mimeType);
  } catch (e) {
    throw fail(e);
  }
  const row = {
    id: fileId,
    key,
    conversationId,
    name,
    mimeType,
    size: bytes.length,
    ...dims,
    source: "bot" as const,
    at: deps.clock.now(),
  };
  try {
    await deps.store.files.insert(row);
    await postStored(
      { store: deps.store, surface: deps.surface },
      {
        conversationId,
        author,
        kind: "file",
        text: caption ?? "",
        files: [toFileRef(row)],
        at: row.at,
      },
    );
  } catch (e) {
    // Best effort: do not leave an object or a row nobody points at.
    await deps.files.delete(key).catch(() => undefined);
    await deps.store.files.delete(fileId).catch(() => undefined);
    throw fail(e);
  }
}

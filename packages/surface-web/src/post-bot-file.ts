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
import { imageSize } from "image-size";
import { imageType } from "./image-type";
import { toFileRef } from "./message-dto";
import { safeName } from "./safe-name";

/** What posting a bot file needs. */
export interface PostBotFileDeps {
  store: Pick<Store, "messages" | "files">;
  files: FileStore;
  clock: Clock;
  surface: Surface;
  log?: Log;
}

/** Pixel size of an image, or `undefined` when the bytes cannot be read as one. */
function sizeOf(bytes: Uint8Array): { width: number; height: number } | undefined {
  try {
    const { width, height } = imageSize(bytes);
    return width && height ? { width, height } : undefined;
  } catch {
    return undefined;
  }
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
  const bytes = await Bun.file(file.path).bytes();
  const fileId = randomUUID();
  const name = safeName(file.name);
  const key = `files/${conversationId}/${fileId}/${name}`;
  const image = imageType(bytes);
  const mimeType = image ?? (Bun.file(file.path).type || "application/octet-stream");
  const dims = image ? sizeOf(bytes) : undefined;
  try {
    await deps.files.put(key, bytes, mimeType);
  } catch (e) {
    deps.log?.warn({ conversationId }, "bot file upload failed");
    throw new Error(`Could not store the file: ${e instanceof Error ? e.message : String(e)}`);
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
}

import { isImageType } from "@friday/surface-web";
import { encodeKey } from "../encode-key";
import { authed } from "../rpc/implementer";
import { toOrpcError } from "../surface-errors";
import { decodeFileCursor, encodeFileCursor, toFileLibraryItem } from "./file-library";

/** Seconds a file download link stays valid. */
const FILE_URL_SECONDS = 900;

/** Sending messages and files. */
export const chatRouter = {
  uploadCreate: authed.chat.uploadCreate.handler(({ input, context }) =>
    context.deps.surface.createUpload(input).catch(toOrpcError),
  ),
  send: authed.chat.send.handler(({ input, context }) =>
    context.deps.surface.send(input).catch(toOrpcError),
  ),
  /** One extra row tells whether another page follows. */
  files: authed.chat.files.handler(async ({ input, context, errors }) => {
    const cursor = input.cursor === undefined ? undefined : decodeFileCursor(input.cursor);
    if (input.cursor !== undefined && !cursor) {
      throw errors.BAD_REQUEST({ message: "Invalid cursor." });
    }
    const rows = await context.deps.store.files.listUploads({
      limit: input.limit + 1,
      ...(cursor && { cursor }),
      ...(input.kind && { kind: input.kind }),
      ...(input.conversationId && { conversationId: input.conversationId }),
    });
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toFileLibraryItem),
      ...(rows.length > input.limit && last && { nextCursor: encodeFileCursor(last) }),
    };
  }),
  /** The key comes from the stored row, never from the client. */
  file: authed.chat.file.handler(async ({ input, context, errors }) => {
    const row = await context.deps.store.files.get(input.id);
    if (!row) throw errors.NOT_FOUND();
    const image = isImageType(row.mimeType);
    // Images go through the owner's public CDN when set; everything else is presigned.
    const cdn = context.deps.cdnUrl;
    if (image && cdn) return { url: `${cdn}/${encodeKey(row.key)}` };
    return {
      url: context.deps.files.presignGet(
        row.key,
        FILE_URL_SECONDS,
        image ? undefined : { downloadName: row.name },
      ),
    };
  }),
};

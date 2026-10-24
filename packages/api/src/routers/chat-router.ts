import { authed } from "../rpc/implementer";
import { toOrpcError } from "../surface-errors";

/** Seconds a file download link stays valid. */
const FILE_URL_SECONDS = 900;

/** Image types shown inline (the web surface's list); anything else downloads under its name. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Sending messages and files. */
export const chatRouter = {
  uploadCreate: authed.chat.uploadCreate.handler(({ input, context }) =>
    context.deps.surface.createUpload(input).catch(toOrpcError),
  ),
  send: authed.chat.send.handler(({ input, context }) =>
    context.deps.surface.send(input).catch(toOrpcError),
  ),
  /** The key comes from the stored row, never from the client. */
  file: authed.chat.file.handler(async ({ input, context, errors }) => {
    const row = await context.deps.store.files.get(input.id);
    if (!row) throw errors.NOT_FOUND();
    const image = IMAGE_TYPES.has(row.mimeType);
    return {
      url: context.deps.files.presignGet(
        row.key,
        FILE_URL_SECONDS,
        image ? undefined : { downloadName: row.name },
      ),
    };
  }),
};

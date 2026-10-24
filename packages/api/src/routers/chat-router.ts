import { isImageType } from "@friday/surface-web";
import { encodeKey } from "../encode-key";
import { authed } from "../rpc/implementer";
import { toOrpcError } from "../surface-errors";

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

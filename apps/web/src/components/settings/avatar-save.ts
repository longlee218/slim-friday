import { client } from "../../api/client";

/** The bot or group whose avatar is changed. */
export interface AvatarTarget {
  kind: "bot" | "group";
  id: string;
}

/** What the owner picked: a preset, an encoded image to upload, or (groups) the member faces. */
export type AvatarChoice =
  | { preset: string }
  | { image: { blob: Blob; type: "image/webp" | "image/jpeg" } }
  | { none: true };

/** Saves a choice for an existing bot or group: an image is uploaded first (ticket, then PUT). */
export async function saveAvatar(target: AvatarTarget, choice: AvatarChoice): Promise<void> {
  let input: { preset: string } | { uploadId: string } | { none: true };
  if ("image" in choice) {
    const { blob, type } = choice.image;
    const ticket = await client.config.avatars.create({
      kind: target.kind,
      id: target.id,
      size: blob.size,
      type,
    });
    const res = await fetch(ticket.putUrl, {
      method: "PUT",
      body: blob,
      headers: { "Content-Type": type },
      credentials: "omit",
    });
    if (!res.ok) throw new Error("put");
    input = { uploadId: ticket.uploadId };
  } else {
    input = choice;
  }
  if (target.kind === "bot") {
    await client.config.bots.setAvatar({ id: target.id, ...(input as { preset: string }) });
  } else {
    await client.config.groups.setAvatar({ id: target.id, ...input });
  }
}

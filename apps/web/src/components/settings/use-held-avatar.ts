import { useState } from "react";
import { toast } from "sonner";
import { type AvatarChoice, type AvatarTarget, saveAvatar } from "./avatar-save";

/** An avatar picked on a New bot / New group page, before there is an id to save it under. */
interface Held {
  choice: AvatarChoice;
  previewUrl: string;
}

/**
 * The avatar chosen before a bot or group exists: `hold` keeps it (the member faces choice clears
 * it), `saveHeld` saves it once the bot or group is created. A failed save never undoes the create.
 */
export function useHeldAvatar() {
  const [held, setHeld] = useState<Held>();
  const hold = (choice: AvatarChoice, previewUrl: string) =>
    setHeld("none" in choice ? undefined : { choice, previewUrl });
  const saveHeld = async (target: AvatarTarget) => {
    if (!held) return;
    try {
      await saveAvatar(target, held.choice);
    } catch {
      toast.error(`The ${target.kind} is saved, but its avatar is not. Pick it again on its page.`);
    }
  };
  return { previewUrl: held?.previewUrl, hold, saveHeld };
}

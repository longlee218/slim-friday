import { useDirectory } from "../../api/directory";

/** A bot's display name and avatar url (the id and no avatar while the bot list is missing it). */
export function useBotFace(botId: string | undefined): { name: string; src?: string } {
  const dir = useDirectory();
  if (!botId) return { name: "" };
  return { name: dir.botName(botId), src: dir.bots.get(botId)?.avatarUrl };
}

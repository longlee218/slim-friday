import type { BotDto, ConversationDto, GroupDto } from "@friday/contracts";
import type { Directory } from "../../api/directory";

/** The bot or group behind a conversation (the id is `bot:<id>` or `group:<id>` if the dto lacks them). */
export function conversationParts(
  dir: Directory,
  conv: ConversationDto,
): { bot?: BotDto; group?: GroupDto } {
  const botId = conv.botId ?? (conv.id.startsWith("bot:") ? conv.id.slice(4) : undefined);
  const groupId = conv.groupId ?? (conv.id.startsWith("group:") ? conv.id.slice(6) : undefined);
  return {
    bot: botId ? dir.bots.get(botId) : undefined,
    group: groupId ? dir.groups.get(groupId) : undefined,
  };
}

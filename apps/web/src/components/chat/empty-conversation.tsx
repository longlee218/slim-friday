import type { BotDto, ConversationDto, GroupDto } from "@friday/contracts";
import { useDirectory } from "../../api/directory";
import { Avatar } from "../ui/avatar";

const BOT_SUGGESTIONS = ["What are you working on?", "Summarise yesterday", "Show my open tickets"];
const GROUP_SUGGESTIONS = ["Plan this week's work", "Who is blocked?"];

export interface EmptyConversationProps {
  conversation: ConversationDto;
  bot?: BotDto;
  group?: GroupDto;
  /** A suggestion fills the composer draft. */
  onSuggest(text: string): void;
}

/** A conversation with no messages yet: who it is, and a few ways to start. */
export function EmptyConversation({ conversation, bot, group, onSuggest }: EmptyConversationProps) {
  const dir = useDirectory();
  const suggestions = group ? GROUP_SUGGESTIONS : BOT_SUGGESTIONS;
  return (
    <div className="empty">
      {group ? (
        <span className="stack">
          {group.members.map((id) => (
            <Avatar key={id} src={dir.bots.get(id)?.avatarUrl} name={dir.botName(id)} size={44} />
          ))}
        </span>
      ) : (
        <Avatar
          src={bot?.avatarUrl ?? conversation.avatarUrl}
          name={bot?.name ?? conversation.title}
          size={84}
        />
      )}
      <h3>{group ? group.name : `Chat with ${bot?.name ?? conversation.title}`}</h3>
      <p>
        {group
          ? `Messages go to ${dir.botName(group.entryBot)} unless you @name a member.`
          : bot?.title}
      </p>
      <div className="suggest">
        {suggestions.map((s) => (
          <button key={s} type="button" onClick={() => onSuggest(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

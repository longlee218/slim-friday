import type { TicketCommentDto } from "@friday/contracts";
import { useDirectory } from "../../api/directory";
import { formatClock } from "../../lib/format";
import { BotMarkdown } from "../markdown/bot-markdown";
import { Avatar } from "../ui/avatar";

/** One comment: face (or the owner's initial), name, time and the markdown body. */
export function TicketComment({ comment: c }: { comment: TicketCommentDto }) {
  const dir = useDirectory();
  const botId = c.author.kind === "bot" ? c.author.botId : null;
  const name = botId ? dir.botName(botId) : c.author.kind === "user" ? "You" : "System";
  return (
    <div className="comment">
      {botId ? (
        <Avatar src={dir.bots.get(botId)?.avatarUrl} name={name} size={24} />
      ) : (
        <span className="initial">{name[0]}</span>
      )}
      <div>
        <b>{name}</b> <span className="t2">{formatClock(c.createdAt, Date.now())}</span>
        <BotMarkdown text={c.body} />
      </div>
    </div>
  );
}

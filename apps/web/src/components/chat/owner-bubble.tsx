import type { MessageDto } from "@friday/contracts";
import { useDirectory } from "../../api/directory";
import { formatClock } from "../../lib/format";
import { Avatar } from "../ui/avatar";
import type { RouteInfo } from "./route-info";
import { useBotFace } from "./use-bot-face";

export interface OwnerBubbleProps {
  message: MessageDto;
  route?: RouteInfo;
  /** Local state of a message not yet confirmed by the engine. */
  pending?: "sending" | "failed";
  onRetry?(): void;
  /** Bot ids of the conversation; only their `@name` is highlighted. */
  members?: string[];
}

const ROUTE_SUFFIX = { direct: "", entry: " · entry", reply: " · reply" } as const;

/** The quoted bot message above a reply: small face, name, one-line excerpt. */
function ReplyQuote({ reply }: { reply: NonNullable<MessageDto["replyTo"]> }) {
  const bot = useBotFace(reply.botId);
  return (
    <div className="quote">
      <Avatar src={bot.src} name={bot.name} size={16} />
      <b>{bot.name}</b>
      <span>{reply.excerpt}</span>
    </div>
  );
}

/** "→ Dev", "→ Pia · entry" or "→ Dev · reply" with the bot's small face. */
function RouteMeta({ route }: { route: RouteInfo }) {
  const bot = useBotFace(route.botId);
  return (
    <span className="route-meta">
      {"→ "}
      <Avatar src={bot.src} name={bot.name} size={14} />
      {bot.name}
      {ROUTE_SUFFIX[route.kind]}
    </span>
  );
}

/** Text with `@name` of a member wrapped in `.at`; every part is a React text node. */
function AtText({ text, names }: { text: string; names: Set<string> }) {
  const parts = text.split(/(@\w+)/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 && names.has(p.slice(1).toLowerCase()) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and static
          <span key={i} className="at">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** The owner's message: right-aligned bubble, optional reply quote, time and route line. */
export function OwnerBubble({ message, route, pending, onRetry, members = [] }: OwnerBubbleProps) {
  const dir = useDirectory();
  const names = new Set(members.map((id) => dir.botName(id).toLowerCase()));
  return (
    <div className="msg owner">
      <div>
        {message.replyTo && <ReplyQuote reply={message.replyTo} />}
        <div className="bubble">
          <AtText text={message.text} names={names} />
        </div>
        <div className="owner-meta">
          {pending === "failed" ? (
            <>
              Not sent ·{" "}
              <button type="button" className="link-btn" onClick={onRetry}>
                Retry
              </button>
            </>
          ) : (
            <>
              {pending === "sending" ? "Sending…" : formatClock(message.at, Date.now())}
              {route && <RouteMeta route={route} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

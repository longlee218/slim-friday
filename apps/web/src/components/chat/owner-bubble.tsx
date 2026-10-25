import type { MessageDto } from "@friday/contracts";
import { Fragment, type ReactNode } from "react";
import { useDirectory } from "../../api/directory";
import { formatClock } from "../../lib/format";
import { Avatar } from "../ui/avatar";
import { FileCard } from "./file-card";
import { ImageGallery } from "./image-gallery";
import { mentionSpans } from "./mentions";
import { ROUTE_SUFFIX, type RouteInfo } from "./route-info";
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

/** "→ Dev", "→ Tess, Dev", "→ Pia · entry" or "→ Dev · reply", each with the bot's small face. */
function RouteMeta({ route }: { route: RouteInfo }) {
  const dir = useDirectory();
  return (
    <span className="route-meta">
      {"→ "}
      {route.botIds.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && ", "}
          <Avatar src={dir.bots.get(id)?.avatarUrl} name={dir.botName(id)} size={14} />
          {dir.botName(id)}
        </Fragment>
      ))}
      {ROUTE_SUFFIX[route.reason]}
    </span>
  );
}

/** Text with `@name` of a member wrapped in `.at`; every part is a React text node. */
function AtText({ text, names }: { text: string; names: string[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { start, end } of mentionSpans(text, names)) {
    parts.push(text.slice(at, start));
    parts.push(
      <span key={start} className="at">
        {text.slice(start, end)}
      </span>,
    );
    at = end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * The owner's message: right-aligned bubble, optional reply quote, the files sent with it
 * (images as a gallery, others as file cards; no empty bubble for a files-only message), time
 * and route line.
 */
export function OwnerBubble({ message, route, pending, onRetry, members = [] }: OwnerBubbleProps) {
  const dir = useDirectory();
  const names = members.map((id) => dir.botName(id));
  const images = message.files.filter((f) => f.kind === "image");
  const others = message.files.filter((f) => f.kind !== "image");
  return (
    <div className="msg owner">
      <div>
        {message.replyTo && <ReplyQuote reply={message.replyTo} />}
        {message.text && (
          <div className="bubble">
            <AtText text={message.text} names={names} />
          </div>
        )}
        {images.length > 0 && <ImageGallery files={images} message={message} />}
        {others.map((f) => (
          <FileCard key={f.id} file={f} />
        ))}
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

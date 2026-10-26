import type { MessageDto } from "@friday/contracts";
import { Fragment, type ReactNode } from "react";
import { useDirectory } from "../../api/directory";
import { formatClock } from "../../lib/format";
import { Avatar } from "../ui/avatar";
import type { RunPlace } from "./bubble-layout";
import { FileCard } from "./file-card";
import { ImageGallery } from "./image-gallery";
import { mentionSpans } from "./mentions";
import { ownerTextParts } from "./owner-text";
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
  /** Place in a run of the owner's messages (default: alone, head and tail). */
  place?: RunPlace;
}

/** The single message of its run. */
const ALONE: RunPlace = { head: true, tail: true };

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

/** The owner's text: code fences as mono blocks, backtick spans as inline chips, the rest plain with `@name` marks. */
function OwnerText({ text, names }: { text: string; names: string[] }) {
  return (
    <>
      {ownerTextParts(text).map((part, i) =>
        part.kind === "fence" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
          <pre key={i} className="o-fence">
            <code>{part.text}</code>
          </pre>
        ) : part.kind === "code" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
          <code key={i} className="o-code">
            {part.text}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
          <AtText key={i} text={part.text} names={names} />
        ),
      )}
    </>
  );
}

/**
 * The owner's message: right-aligned gradient bubble, optional reply quote, the files sent with it
 * (images as a gallery, others as file cards; no empty bubble for a files-only message). The time
 * and route line show under the last message of a run, and always while sending or failed; inside a
 * run the time is the bubble's tooltip.
 */
export function OwnerBubble({
  message,
  route,
  pending,
  onRetry,
  members = [],
  place = ALONE,
}: OwnerBubbleProps) {
  const dir = useDirectory();
  const names = members.map((id) => dir.botName(id));
  const images = message.files.filter((f) => f.kind === "image");
  const others = message.files.filter((f) => f.kind !== "image");
  const time = formatClock(message.at, Date.now());
  const cls = ["msg", "owner", place.head && "first", place.tail && "last"];
  return (
    <div className={cls.filter(Boolean).join(" ")}>
      <div>
        {message.replyTo && <ReplyQuote reply={message.replyTo} />}
        {message.text && (
          <div className="bubble" title={place.tail ? undefined : time}>
            <OwnerText text={message.text} names={names} />
          </div>
        )}
        {images.length > 0 && <ImageGallery files={images} message={message} />}
        {others.map((f) => (
          <FileCard key={f.id} file={f} />
        ))}
        {(place.tail || pending || route) && (
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
                {pending === "sending" ? "Sending…" : time}
                {route && <RouteMeta route={route} />}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

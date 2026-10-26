import type { MessageDto, MessageReaction } from "@friday/contracts";
import { useEffect, useRef } from "react";
import { formatClock } from "../../lib/format";
import { BotMarkdown } from "../markdown/bot-markdown";
import { Avatar } from "../ui/avatar";
import { isRichText, type RunPlace } from "./bubble-layout";
import { FileCard } from "./file-card";
import { ImageGallery } from "./image-gallery";
import { MessageActions } from "./message-actions";
import type { ReactionCounts } from "./reactions";
import { MessageScheduleTag } from "./schedule-tag";
import { useBotFace } from "./use-bot-face";
import { WorkedDisclosure } from "./worked-disclosure";

export interface BotMessageProps {
  message: MessageDto;
  /** Phone layout: 28 px avatar, no hover actions (swipe replies instead). */
  phone: boolean;
  onReply(m: MessageDto): void;
  /** The owner reacts with an emoji; the React button shows when given (not on the phone, which uses the sheet). */
  onReact?(m: MessageDto, emoji: MessageReaction): void;
  /** Reactions folded under this message. */
  reactions?: ReactionCounts;
  /** Just arrived over the stream: animates in (`msgIn`). */
  fresh?: boolean;
  /** Group chat: the bot's name shows above the first message of a run. */
  group?: boolean;
  /** Place in a run of this bot's messages (default: alone, head and tail). */
  place?: RunPlace;
}

/** The single message of its run. */
const ALONE: RunPlace = { head: true, tail: true };

/** The emoji the owner reacted with, each with its count when above one; a chip that appears or grows pops once. */
function ReactionChips({ counts }: { counts: ReactionCounts }) {
  const seen = useRef(counts);
  const entries = Object.entries(counts);
  useEffect(() => {
    seen.current = counts;
  });
  if (entries.length === 0) return null;
  return (
    <div className="msg-reacts">
      {entries.map(([emoji, n]) => (
        <span
          key={emoji}
          className={
            n > (seen.current[emoji as keyof ReactionCounts] ?? 0) ? "react-chip pop" : "react-chip"
          }
        >
          {emoji}
          {n > 1 && <b>{n}</b>}
        </span>
      ))}
    </div>
  );
}

/**
 * A bot's message, Messenger style: a grey bubble (or, for block content, the full column without a
 * fill), the face at the bottom-left of a run, the name above its first message in groups, then
 * images and files, reactions, and time and schedule tag under the last one. Reply, React and Copy
 * show beside the bubble on hover; a message inside a run keeps its time as a tooltip.
 */
export function BotMessage({
  message,
  phone,
  onReply,
  onReact,
  reactions,
  fresh,
  group = false,
  place = ALONE,
}: BotMessageProps) {
  const bot = useBotFace(message.author.kind === "bot" ? message.author.botId : undefined);
  const images = message.files.filter((f) => f.kind === "image");
  const others = message.files.filter((f) => f.kind !== "image");
  const rich = isRichText(message.text);
  const time = formatClock(message.at, Date.now());
  const atts = (images.length > 0 || others.length > 0) && (
    <div className="atts">
      {images.length > 0 && <ImageGallery files={images} message={message} />}
      {others.map((f) => (
        <FileCard key={f.id} file={f} />
      ))}
    </div>
  );
  const cls = [
    "msg",
    "bot",
    place.head && "first",
    place.tail && "last",
    rich && "rich",
    fresh && "new",
  ];
  return (
    // `data-mi` (phone only) marks the message for swipe-to-reply and press-and-hold.
    <div className={cls.filter(Boolean).join(" ")} data-mi={phone ? message.id : undefined}>
      <div className="face">
        {place.tail && <Avatar src={bot.src} name={bot.name} size={phone ? 28 : 30} />}
      </div>
      <div className="body">
        {group && place.head && (
          <div className="who">
            <b>{bot.name}</b>
          </div>
        )}
        {message.run && message.run.length > 0 && <WorkedDisclosure steps={message.run} />}
        <div className="brow">
          {message.text ? (
            <div className={rich ? "md rich" : "bubble md"} title={place.tail ? undefined : time}>
              <BotMarkdown text={message.text} />
            </div>
          ) : (
            atts
          )}
          {!phone && (
            <MessageActions
              message={message}
              onReply={() => onReply(message)}
              {...(onReact && { onReact: (emoji: MessageReaction) => onReact(message, emoji) })}
            />
          )}
        </div>
        {message.text && atts}
        {reactions && <ReactionChips counts={reactions} />}
        {(place.tail || message.schedule) && (
          <div className="meta">
            {place.tail && <time>{time}</time>}
            {message.schedule && <MessageScheduleTag schedule={message.schedule} />}
          </div>
        )}
      </div>
    </div>
  );
}

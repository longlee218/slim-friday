import type { MessageDto, MessageReaction } from "@friday/contracts";
import { useEffect, useRef } from "react";
import { formatClock } from "../../lib/format";
import { BotMarkdown } from "../markdown/bot-markdown";
import { Avatar } from "../ui/avatar";
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
}

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

/** A bot's message: avatar, name, time and schedule tag, text, then images and files, reactions, then actions. */
export function BotMessage({
  message,
  phone,
  onReply,
  onReact,
  reactions,
  fresh,
}: BotMessageProps) {
  const bot = useBotFace(message.author.kind === "bot" ? message.author.botId : undefined);
  const images = message.files.filter((f) => f.kind === "image");
  const others = message.files.filter((f) => f.kind !== "image");
  return (
    // `data-mi` (phone only) marks the message for swipe-to-reply and press-and-hold.
    <div className={fresh ? "msg new" : "msg"} data-mi={phone ? message.id : undefined}>
      <Avatar src={bot.src} name={bot.name} size={phone ? 28 : 30} />
      <div className="body">
        <div className="who">
          <b>{bot.name}</b>
          <time>{formatClock(message.at, Date.now())}</time>
          {message.schedule && <MessageScheduleTag schedule={message.schedule} />}
        </div>
        {message.run && message.run.length > 0 && <WorkedDisclosure steps={message.run} />}
        {message.text && (
          <div className="md">
            <BotMarkdown text={message.text} />
          </div>
        )}
        {images.length > 0 && <ImageGallery files={images} message={message} />}
        {others.map((f) => (
          <FileCard key={f.id} file={f} />
        ))}
        {reactions && <ReactionChips counts={reactions} />}
        {!phone && (
          <MessageActions
            message={message}
            onReply={() => onReply(message)}
            {...(onReact && { onReact: (emoji: MessageReaction) => onReact(message, emoji) })}
          />
        )}
      </div>
    </div>
  );
}

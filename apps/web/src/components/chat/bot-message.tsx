import type { MessageDto } from "@friday/contracts";
import { formatClock } from "../../lib/format";
import { BotMarkdown } from "../markdown/bot-markdown";
import { Avatar } from "../ui/avatar";
import { FileCard } from "./file-card";
import { ImageGallery } from "./image-gallery";
import { MessageActions } from "./message-actions";
import { useBotFace } from "./use-bot-face";

export interface BotMessageProps {
  message: MessageDto;
  /** Phone layout: 28 px avatar, no hover actions (swipe replies instead). */
  phone: boolean;
  onReply(m: MessageDto): void;
  /** Just arrived over the stream: animates in (`msgIn`). */
  fresh?: boolean;
}

/** A bot's message: avatar, name and time, text, then images and files, then actions. */
export function BotMessage({ message, phone, onReply, fresh }: BotMessageProps) {
  const bot = useBotFace(message.author.kind === "bot" ? message.author.botId : undefined);
  const images = message.files.filter((f) => f.kind === "image");
  const others = message.files.filter((f) => f.kind !== "image");
  return (
    <div className={fresh ? "msg new" : "msg"}>
      <Avatar src={bot.src} name={bot.name} size={phone ? 28 : 30} />
      <div className="body">
        <div className="who">
          <b>{bot.name}</b>
          <time>{formatClock(message.at, Date.now())}</time>
        </div>
        {/* Task 12 inserts <WorkedDisclosure run={message.run} /> here, before the text. */}
        {message.text && (
          <div className="md">
            <BotMarkdown text={message.text} />
          </div>
        )}
        {images.length > 0 && <ImageGallery files={images} message={message} />}
        {others.map((f) => (
          <FileCard key={f.id} file={f} />
        ))}
        {!phone && <MessageActions message={message} onReply={() => onReply(message)} />}
      </div>
    </div>
  );
}

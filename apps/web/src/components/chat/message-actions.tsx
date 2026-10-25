import { MESSAGE_REACTIONS, type MessageDto, type MessageReaction } from "@friday/contracts";
import { Check, Copy, Reply, SmilePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useCopy } from "../markdown/use-copy";
import { IconButton } from "../ui/button";
import { useBotFace } from "./use-bot-face";

export interface MessageActionsProps {
  message: MessageDto;
  onReply(): void;
  /** Shows the React button and its emoji row when given. */
  onReact?(emoji: MessageReaction): void;
}

/** Reply, React and Copy under a bot message; quiet until hover or focus (space is always reserved). */
export function MessageActions({ message, onReply, onReact }: MessageActionsProps) {
  const [picking, setPicking] = useState(false);
  const bot = useBotFace(message.author.kind === "bot" ? message.author.botId : undefined);
  const [copied, copy] = useCopy(message.text);
  // `copied` only turns true once the clipboard accepted the text, so the toast is honest.
  useEffect(() => {
    if (copied) toast("Message copied.");
  }, [copied]);
  return (
    <div className="msg-acts">
      <IconButton label={`Reply to ${bot.name}`} onClick={onReply}>
        <Reply size={16} strokeWidth={1.75} />
      </IconButton>
      {onReact && (
        <IconButton label="React" on={picking} onClick={() => setPicking((p) => !p)}>
          <SmilePlus size={16} strokeWidth={1.75} />
        </IconButton>
      )}
      <IconButton label="Copy" onClick={copy}>
        {copied ? <Check size={16} strokeWidth={1.75} /> : <Copy size={16} strokeWidth={1.75} />}
      </IconButton>
      {picking && onReact && (
        <fieldset className="react-row" aria-label="Reactions">
          {MESSAGE_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="react-pick"
              aria-label={`React ${emoji}`}
              onClick={() => {
                onReact(emoji);
                setPicking(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}

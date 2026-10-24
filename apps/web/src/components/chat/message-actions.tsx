import type { MessageDto } from "@friday/contracts";
import { Check, Copy, Reply } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { useCopy } from "../markdown/use-copy";
import { IconButton } from "../ui/button";
import { useBotFace } from "./use-bot-face";

/** Reply and Copy under a bot message; quiet until hover or focus (space is always reserved). */
export function MessageActions({ message, onReply }: { message: MessageDto; onReply(): void }) {
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
      <IconButton label="Copy" onClick={copy}>
        {copied ? <Check size={16} strokeWidth={1.75} /> : <Copy size={16} strokeWidth={1.75} />}
      </IconButton>
    </div>
  );
}

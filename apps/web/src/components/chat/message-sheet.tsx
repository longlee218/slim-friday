import type { MessageDto } from "@friday/contracts";
import { Copy, Reply } from "lucide-react";
import { BottomSheet } from "../ui/bottom-sheet";
import { Button } from "../ui/button";
import { useBotFace } from "./use-bot-face";

/** Characters of the message shown in the peek. */
const PEEK_CHARS = 120;

export interface MessageSheetProps {
  message: MessageDto;
  open: boolean;
  onOpenChange(open: boolean): void;
  onReply(): void;
  onCopy(): void;
}

/** Press-and-hold sheet of one bot message (phone): a three-line peek, Reply, Copy, Cancel. */
export function MessageSheet({ message, open, onOpenChange, onReply, onCopy }: MessageSheetProps) {
  const bot = useBotFace(message.author.kind === "bot" ? message.author.botId : undefined);
  // An action runs, then the sheet closes.
  const act = (fn: () => void) => () => {
    fn();
    onOpenChange(false);
  };
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <p className="msg-peek">
        <b>{bot.name}</b> {message.text.slice(0, PEEK_CHARS)}
      </p>
      <Button size="lg" onClick={act(onReply)}>
        <Reply strokeWidth={1.75} />
        Reply
      </Button>
      <Button size="lg" onClick={act(onCopy)}>
        <Copy strokeWidth={1.75} />
        Copy
      </Button>
      <Button size="lg" onClick={() => onOpenChange(false)}>
        Cancel
      </Button>
    </BottomSheet>
  );
}

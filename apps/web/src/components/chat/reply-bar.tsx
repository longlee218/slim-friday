import { Reply, X } from "lucide-react";
import { IconButton } from "../ui/button";

export interface ReplyBarProps {
  botName: string;
  excerpt: string;
  onCancel(): void;
}

/** "Replying to <Bot>" with a one-line excerpt, above the composer text. */
export function ReplyBar({ botName, excerpt, onCancel }: ReplyBarProps) {
  return (
    <div className="reply-bar">
      <Reply size={15} strokeWidth={1.75} />
      <div className="grow">
        <b>{`Replying to ${botName}`}</b>
        <span>{excerpt}</span>
      </div>
      <IconButton label="Cancel reply" onClick={onCancel}>
        <X size={14} strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}

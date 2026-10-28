import { useState } from "react";
import { useCommentTicket } from "./use-comment-ticket";

/**
 * Draft state of a ticket's comment box: the text, whether sending is allowed (non-blank and not
 * already posting), `send`, which posts the trimmed text and clears the box once saved, and `note`,
 * the server's reason when nobody was woken (cleared on the next input).
 */
export function useCommentDraft(ref: string) {
  const comment = useCommentTicket(ref);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string>();
  const body = text.trim();
  return {
    text,
    setText: (v: string) => {
      setText(v);
      setNote(undefined);
    },
    note,
    disabled: !body || comment.isPending,
    send: () => {
      if (!body) return;
      comment.mutate(body, {
        onSuccess: (r) => {
          setText("");
          setNote(r.woke ? undefined : r.note);
        },
      });
    },
  };
}

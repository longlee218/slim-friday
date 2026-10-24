import { useState } from "react";
import { useCommentTicket } from "./use-comment-ticket";

/**
 * Draft state of a ticket's comment box: the text, whether sending is allowed (non-blank and not
 * already posting) and `send`, which posts the trimmed text and clears the box once saved.
 */
export function useCommentDraft(ref: string) {
  const comment = useCommentTicket(ref);
  const [text, setText] = useState("");
  const body = text.trim();
  return {
    text,
    setText,
    disabled: !body || comment.isPending,
    send: () => {
      if (body) comment.mutate(body, { onSuccess: () => setText("") });
    },
  };
}

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { client } from "../../api/client";
import { applyEffects } from "../../events/apply-effects";

/** Wait after the newest id changes before telling the server (a burst counts once). */
const MARK_READ_MS = 500;

/** True while the browser tab is visible. */
function useTabVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/**
 * Marks the conversation read 500 ms after the newest message is on screen: the tab is
 * visible and the transcript is at the bottom. The local unread badge goes to 0 through
 * the same `setUnread` effect the event stream uses.
 */
export function useMarkRead(
  conversationId: string,
  newestId: number | undefined,
  atBottom: boolean,
): void {
  const qc = useQueryClient();
  const visible = useTabVisible();
  // Last id sent per conversation: the same id is never sent twice.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (newestId === undefined || !atBottom || !visible) return;
    const mark = `${conversationId}:${newestId}`;
    if (sent.current === mark) return;
    const t = setTimeout(() => {
      sent.current = mark;
      client.conversations
        .markRead({ id: conversationId, messageId: newestId })
        .then(() => applyEffects(qc, [{ op: "setUnread", conversationId, unread: 0 }], () => {}))
        // A failed call keeps the badge and may be tried again.
        .catch(() => {
          if (sent.current === mark) sent.current = null;
        });
    }, MARK_READ_MS);
    return () => clearTimeout(t);
  }, [conversationId, newestId, atBottom, visible, qc]);
}

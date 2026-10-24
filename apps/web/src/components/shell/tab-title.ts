import type { ConversationDto } from "@friday/contracts";
import { useEffect } from "react";
import { useDirectory } from "../../api/directory";

/** `"Friday"`, or `"(3) Friday"` with the unread total of every conversation. */
export function tabTitle(conversations: ConversationDto[]): string {
  const unread = conversations.reduce((sum, c) => sum + c.unread, 0);
  return unread > 0 ? `(${unread}) Friday` : "Friday";
}

/** Keeps `document.title` in step with the unread total. */
export function useTabTitle(): void {
  const { conversations } = useDirectory();
  const title = tabTitle(conversations);
  useEffect(() => {
    document.title = title;
  }, [title]);
}

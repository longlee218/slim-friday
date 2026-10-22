import { useRef } from "react";
import { chatTitle, useChat } from "../chat/chat-store";
import type { Chat } from "../chat/chat-types";
import { Dialog } from "../ui/dialog";

/**
 * Confirm before anything is removed. A group goes with its history and memory;
 * a direct chat removes the teammate itself. Cancel has focus, so Enter is safe.
 */
export function DeleteChatDialog({ chat: open, onClose }: { chat: Chat | null; onClose(): void }) {
  const { runtime, teammate } = useChat();
  // Keep the last chat while the dialog animates out, so its text does not change mid-exit.
  const last = useRef(open);
  if (open) last.current = open;
  const chat = open ?? last.current;
  const name = chat ? chatTitle(chat, teammate) : "";
  const group = chat?.kind === "group";

  const confirm = () => {
    if (!open || !chat) return;
    if (chat.kind === "group") runtime.deleteGroup(chat.id);
    else runtime.removeTeammate(chat.with);
    onClose();
  };

  return (
    <Dialog open={open !== null} title={group ? `Delete “${name}”?` : `Remove ${name}?`} onClose={onClose}>
      <p className="dialog__note">
        {group
          ? "The chat, its history and the group memory are deleted. Members stay on your team."
          : `${name} leaves your team. Their chat, instructions and memory are deleted.`}{" "}
        This can’t be undone.
      </p>
      <div className="dialog__actions">
        <button type="button" className="btn btn--lg" onClick={onClose} data-autofocus>
          Cancel
        </button>
        <button type="button" className="btn btn--lg btn--danger" onClick={confirm}>
          {group ? "Delete group" : "Remove"}
        </button>
      </div>
    </Dialog>
  );
}

import { useCallback, useState } from "react";
import { useChat } from "../chat/chat-store";
import type { Chat, GroupChat } from "../chat/chat-types";
import type { MenuItem } from "../ui/menu";
import { DeleteChatDialog } from "./delete-chat-dialog";
import { EditGroupDialog } from "./edit-group-dialog";

/**
 * Chat actions shared by the chat list menu and the details panel:
 * the menu items for a chat, and the edit / delete dialogs they open.
 * Render `dialogs` once where the hook is used.
 */
export function useChatActions() {
  const { state, runtime } = useChat();
  const [editing, setEditing] = useState<GroupChat | null>(null);
  const [deleting, setDeleting] = useState<Chat | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);
  const closeDelete = useCallback(() => setDeleting(null), []);

  /** Why a teammate can't be removed, if it can't. */
  const removeBlock = (chat: Chat): string | undefined => {
    if (chat.kind !== "direct") return undefined;
    const t = state.team.find((x) => x.id === chat.with);
    if (t?.role === "lead") return "Your chief of staff stays";
    const groups = state.chats.filter((c) => c.kind === "group" && c.members.includes(chat.with));
    if (groups.length) return `Still in ${groups.length === 1 ? (groups[0] as GroupChat).name : `${groups.length} groups`}`;
    return undefined;
  };

  const menuItems = (chat: Chat): MenuItem[] => {
    const items: MenuItem[] = [
      chat.unread
        ? { label: "Mark as read", icon: "read", onSelect: () => runtime.setUnread(chat.id, false) }
        : { label: "Mark as unread", icon: "unread", onSelect: () => runtime.setUnread(chat.id, true) },
    ];
    if (chat.kind === "group") {
      items.push(
        { label: "Edit group", icon: "pencil", onSelect: () => setEditing(chat) },
        { label: "Delete group", icon: "trash", danger: true, onSelect: () => setDeleting(chat) },
      );
    } else {
      const block = removeBlock(chat);
      items.push({ label: "Remove teammate", icon: "trash", danger: true, disabled: !!block, hint: block, onSelect: () => setDeleting(chat) });
    }
    return items;
  };

  const dialogs = (
    <>
      <EditGroupDialog chat={editing} onClose={closeEdit} />
      <DeleteChatDialog chat={deleting} onClose={closeDelete} />
    </>
  );

  return { menuItems, removeBlock, edit: setEditing, remove: setDeleting, dialogs };
}

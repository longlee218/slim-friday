import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { Ellipsis, MessageCircle, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { DeleteTarget } from "./delete-chat-sheet";

export interface ChatRowMenuProps {
  target: DeleteTarget;
  /** Shown in the ⋯ button's label. */
  name: string;
  /** False for a shipped or reserved bot: the menu has no Delete. */
  deletable: boolean;
  onOpen(): void;
  onDelete(target: DeleteTarget): void;
  /** The row itself (a link). */
  children: ReactNode;
}

/** The menu items, built from either menu's parts (context menu and ⋯ menu share them). */
function items(p: ChatRowMenuProps, M: typeof Menu | typeof ContextMenu) {
  return (
    <>
      <M.Item className="rm-item" onClick={p.onOpen}>
        <MessageCircle size={15} strokeWidth={1.75} />
        Open chat
      </M.Item>
      {p.deletable && (
        <>
          <M.Separator className="rm-sep" />
          <M.Item className="rm-item danger" onClick={() => p.onDelete(p.target)}>
            <Trash2 size={15} strokeWidth={1.75} />
            {p.target.kind === "bot" ? "Delete bot…" : "Delete group…"}
          </M.Item>
        </>
      )}
    </>
  );
}

/**
 * Desktop chat row actions: right-click the row, or the ⋯ button shown on hover, opens a menu with
 * Open chat and (for an owner bot or any group) a red Delete that asks the caller to confirm.
 */
export function ChatRowMenu(p: ChatRowMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger className="rm-row">
        {p.children}
        <Menu.Root>
          <Menu.Trigger className="rm-more" aria-label={`More for ${p.name}`}>
            <Ellipsis size={16} strokeWidth={1.75} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4}>
              <Menu.Popup className="rm-popup">{items(p, Menu)}</Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup className="rm-popup">{items(p, ContextMenu)}</ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

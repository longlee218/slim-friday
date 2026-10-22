import { AnimatePresence, LayoutGroup } from "motion/react";
import { type RefObject, useCallback, useState } from "react";
import { useChatActions } from "../chat-actions/use-chat-actions";
import { chatTitle, useChat } from "../chat/chat-store";
import type { Chat } from "../chat/chat-types";
import type { NewKind } from "../compose/new-chat";
import { Icon } from "../ui/icon";
import { Menu, type MenuAnchor } from "../ui/menu";
import { ChatRow } from "./chat-row";

interface Props {
  phone: boolean;
  dark: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  onOpen(id: string): void;
  onCompose(kind: NewKind): void;
  onToggleSidebar(): void;
  onToggleTheme(x: number, y: number): void;
}

/** Source list: one recent list of groups and direct chats, newest first. */
export function Sidebar({ phone, dark, searchRef, onOpen, onCompose, onToggleSidebar, onToggleTheme }: Props) {
  const { state, teammate } = useChat();
  const [query, setQuery] = useState("");
  const actions = useChatActions();
  // One menu at a time: a chat's actions, or the "new" choices.
  const [menu, setMenu] = useState<{ chat?: Chat; at: MenuAnchor } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const q = query.trim().toLowerCase();
  const chats = [...state.chats]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((c) => !q || chatTitle(c, teammate).toLowerCase().includes(q));

  return (
    <aside className="sidebar" aria-label="Chats">
      <div className="sidebar__top">
        <h1 className="sidebar__title">Chats</h1>
        <span className="spacer" />
        <button type="button" className="tool hide-phone" onClick={onToggleSidebar} aria-label="Hide sidebar" title="Hide sidebar">
          <Icon name="sidebar" />
        </button>
        <button
          type="button"
          className="tool"
          aria-label="New teammate or group"
          title="New teammate or group (⌘N)"
          aria-haspopup="menu"
          aria-expanded={menu !== null && !menu.chat}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ at: { x: r.right - 228, y: r.bottom + 4 } });
          }}
        >
          <Icon name="compose" />
        </button>
      </div>
      <label className="search">
        <Icon name="search" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search chats"
          autoComplete="off"
        />
      </label>
      <nav className="sidebar__list">
        {/* Rows glide to their new place when a chat gets activity; the selection pill slides between rows. */}
        <LayoutGroup>
          <AnimatePresence initial={false}>
            {chats.map((c, i) => (
              <ChatRow
                key={c.id}
                chat={c}
                index={i}
                selected={!phone && c.id === state.activeId}
                menuOpen={menu?.chat?.id === c.id}
                avatarSize={phone ? 48 : 36}
                onOpen={onOpen}
                onMenu={(chat, x, y) => setMenu({ chat, at: { x, y } })}
              />
            ))}
          </AnimatePresence>
        </LayoutGroup>
        {state.chats.length === 0 && (
          <div className="sidebar__empty">
            <b>No teammates yet</b>
            <span>Create one to start a chat.</span>
            <button type="button" className="btn btn--primary" onClick={() => onCompose("teammate")}>
              New teammate
            </button>
          </div>
        )}
        {state.chats.length > 0 && chats.length === 0 && <p className="sidebar__none">No chats match “{query}”.</p>}
      </nav>
      <div className="sidebar__foot">
        <span className="me-badge" aria-hidden="true">L</span>
        <span className="sidebar__me">
          <b>Long</b>
          <span>${state.spend.toFixed(2)} today</span>
        </span>
        <button
          type="button"
          className="tool"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onToggleTheme(r.left + r.width / 2, r.top + r.height / 2);
          }}
          aria-label={dark ? "Use light appearance" : "Use dark appearance"} title="Appearance">
          <Icon name={dark ? "sun" : "moon"} />
        </button>
      </div>
      <Menu
        anchor={menu?.at ?? null}
        label={menu?.chat ? `Actions for ${chatTitle(menu.chat, teammate)}` : "New"}
        items={
          menu?.chat
            ? actions.menuItems(menu.chat)
            : [
                { label: "New teammate", icon: "person", onSelect: () => onCompose("teammate") },
                { label: "New group", icon: "people", onSelect: () => onCompose("group") },
              ]
        }
        onClose={closeMenu}
      />
      {actions.dialogs}
    </aside>
  );
}

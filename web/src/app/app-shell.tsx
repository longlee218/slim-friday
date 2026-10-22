import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "../chat/chat-store";
import { type NewKind, NewChat } from "../compose/new-chat";
import { ConversationPane } from "../conversation/conversation-pane";
import { Inspector } from "../inspector/inspector";
import { Sidebar } from "../sidebar/sidebar";
import { EXIT_FAST, SPRING_SOFT } from "../ui/motion-presets";
import { NARROW, PHONE, useMediaQuery } from "./use-media-query";
import { useSwipeBack } from "./use-swipe-back";
import { useTheme } from "./use-theme";
import { withViewTransition } from "./view-transition";

/**
 * Full-page layout: sidebar · conversation · inspector.
 * Phone: list and chat are two pushed screens; inspector is full screen.
 */
export function AppShell() {
  const { state, select, active } = useChat();
  const phone = useMediaQuery(PHONE);
  const narrow = useMediaQuery(NARROW);
  const { dark, toggle } = useTheme();
  const [screen, setScreen] = useState<"list" | "chat">("list");
  const [inspector, setInspector] = useState(!narrow);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  // Inspector sub-pages (instructions, memory) need a wider column.
  const [inspectorWide, setInspectorWide] = useState(false);
  // New teammate / group screen replaces the conversation while open.
  const [creating, setCreating] = useState<NewKind | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const notify = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(null), 1800);
  }, []);
  const open = useCallback(
    (id: string) => {
      const go = () => {
        select(id);
        setCreating(null);
        setScreen("chat");
        if (phone) setInspector(false);
      };
      // Phone: the chat screen pushes in over the list (View Transition).
      if (phone && screen === "list") withViewTransition("push", go);
      else go();
    },
    [select, phone, screen],
  );
  const back = useCallback(() => withViewTransition("pop", () => setScreen("list")), []);
  const compose = useCallback((kind: NewKind) => {
    const go = () => {
      setCreating(kind);
      setScreen("chat");
    };
    if (phone && screen === "list") withViewTransition("push", go);
    else go();
  }, [phone, screen]);
  // The runtime already opened the new chat; leave the form and greet.
  const created = useCallback(() => {
    setCreating(null);
    notify("Created. Say hello.");
  }, [notify]);
  const cancelCreate = useCallback(() => {
    const go = () => {
      setCreating(null);
      setScreen("list");
    };
    if (phone) withViewTransition("pop", go);
    else setCreating(null);
  }, [phone]);
  const showInspector = Boolean(active && inspector && !creating);

  // Phone back swipe: the gesture already animated the screen away, so no View Transition.
  const swipedBack = useCallback(() => {
    setCreating(null);
    setScreen("list");
  }, []);
  const listEl = useCallback(() => document.querySelector<HTMLElement>(".window > .sidebar"), []);
  useSwipeBack(mainRef, listEl, phone && screen === "chat" && !showInspector, swipedBack);

  // The open chat was deleted: phone goes back to the list.
  useEffect(() => {
    if (phone && screen === "chat" && !active && !creating) setScreen("list");
  }, [phone, screen, active, creating]);

  // Window shortcuts: ⌘K search, ⌘N new, Esc closes details, ↑/↓ switch chats outside text fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea");
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setScreen("list");
        setSidebarHidden(false);
        searchRef.current?.focus();
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        compose("teammate");
      } else if (e.key === "Escape" && narrow) {
        setInspector(false);
      } else if (!typing && !mod && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const list = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
        const i = list.findIndex((c) => c.id === state.activeId);
        const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) {
          e.preventDefault();
          open(next.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.chats, state.activeId, narrow, open, compose]);

  return (
    <div className="desk">
      <div
        className="window"
        data-screen={phone ? screen : "both"}
        data-inspector={showInspector || undefined}
        data-inspector-wide={(showInspector && inspectorWide) || undefined}
        data-sidebar-hidden={(sidebarHidden && !phone) || undefined}
      >
        <Sidebar
          phone={phone}
          dark={dark}
          searchRef={searchRef}
          onOpen={open}
          onCompose={compose}
          onToggleSidebar={() => setSidebarHidden((v) => !v)}
          onToggleTheme={toggle}
        />
        <main className="conversation" ref={mainRef}>
          {creating ? (
            <NewChat kind={creating} onKind={setCreating} onCancel={cancelCreate} onDone={created} />
          ) : active ? (
            <ConversationPane
              chat={active}
              phone={phone}
              inspectorOpen={inspector}
              onBack={back}
              onToggleInspector={() => setInspector((v) => !v)}
            />
          ) : (
            <div className="conversation__none">Select a chat</div>
          )}
        </main>
        <AnimatePresence>
          {showInspector && active && <Inspector
              key="inspector"
              chat={active}
              phone={phone}
              onClose={() => setInspector(false)}
              onWide={setInspectorWide}
            />}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            className="toast"
            role="status"
            initial={{ opacity: 0, y: 16, scale: 0.96, x: "-50%" }}
            animate={{ opacity: 1, y: 0, scale: 1, x: "-50%", transition: SPRING_SOFT }}
            exit={{ opacity: 0, y: 8, scale: 0.98, x: "-50%", transition: EXIT_FAST }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

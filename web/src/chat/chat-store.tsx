import { createContext, type ReactNode, useContext, useMemo, useReducer, useRef } from "react";
import { type ChatState, chatReducer } from "./chat-reducer";
import type { Chat, Teammate } from "./chat-types";
import { FIXTURE_CHATS, FIXTURE_TEAM } from "./fixture-data";
import type { ChatRuntime } from "./chat-runtime";
import { createFixtureRuntime } from "./fixture-runtime";

interface ChatStore {
  state: ChatState;
  runtime: ChatRuntime;
  select(chatId: string): void;
  teammate(id: string): Teammate | undefined;
  active: Chat | undefined;
}

const Ctx = createContext<ChatStore | null>(null);

const INITIAL: ChatState = {
  team: FIXTURE_TEAM,
  chats: FIXTURE_CHATS,
  activeId: FIXTURE_CHATS[0]?.id ?? null,
  typing: {},
  connection: "online",
  spend: 4.82,
};

/** Holds screen state and the runtime that talks to the agent (fixture for now). */
export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, INITIAL);
  // The runtime reads the latest state through a ref so its timers never see stale data.
  const ref = useRef(state);
  ref.current = state;
  const runtime = useMemo(() => createFixtureRuntime(dispatch, () => ref.current), []);

  const store = useMemo<ChatStore>(
    () => ({
      state,
      runtime,
      select: (chatId) => dispatch({ type: "select", chatId }),
      teammate: (id) => state.team.find((t) => t.id === id),
      active: state.chats.find((c) => c.id === state.activeId),
    }),
    [state, runtime],
  );
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useChat(): ChatStore {
  const store = useContext(Ctx);
  if (!store) throw new Error("useChat must be used inside ChatProvider");
  return store;
}

/** Chat title: teammate name for a direct chat, group name otherwise. */
export function chatTitle(chat: Chat, teammate: (id: string) => Teammate | undefined): string {
  return chat.kind === "direct" ? (teammate(chat.with)?.name ?? "Unknown") : chat.name;
}

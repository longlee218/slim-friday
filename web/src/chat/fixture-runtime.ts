import type { ChatAction, ChatState } from "./chat-reducer";
import type { ChatRuntime } from "./chat-runtime";
import type { GroupChat } from "./chat-types";
import { REPLY } from "./fixture-replies";
import { ROLE_LABEL } from "./role-labels";
import { ROLE_TEMPLATES } from "./role-templates";

/** "Today 12:05" stamp for a new chat. */
const stamp = () =>
  `Today ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;

const TURN_COST = 0.07;
const id = () => Math.random().toString(36).slice(2, 10);

export function createFixtureRuntime(
  dispatch: (a: ChatAction) => void,
  getState: () => ChatState,
): ChatRuntime {
  const timers = new Map<string, number>();
  const teammate = (tid: string) => getState().team.find((t) => t.id === tid);
  const chat = (cid: string) => getState().chats.find((c) => c.id === cid);

  /** Show typing for a teammate, then post its message. */
  function reply(chatId: string, from: string, text: string, ms: number, done?: () => void, replyTo?: string) {
    dispatch({ type: "typing", chatId, teammateId: from });
    timers.set(
      chatId,
      window.setTimeout(() => {
        dispatch({ type: "typing", chatId });
        dispatch({ type: "append", chatId, message: { id: id(), kind: "text", from, text, replyTo } });
        done?.();
      }, ms),
    );
  }

  /** Group loop: router picks speakers in order; an @mention goes first; caps stop it. */
  function runGroup(g: GroupChat, text: string) {
    const named = g.members.find(
      (m) => m !== g.router && new RegExp(`@${teammate(m)?.name}\\b`, "i").test(text),
    );
    const rest = g.members.filter((m) => m !== g.router && m !== named);
    const order = (named ? [named, ...rest] : rest).slice(0, 3);
    let step = 0;
    dispatch({ type: "groupRun", chatId: g.id, run: "running" });
    dispatch({ type: "append", chatId: g.id, message: { id: id(), kind: "route", from: g.router, to: order[0] } });

    const next = () => {
      const cur = chat(g.id);
      if (!cur || cur.kind !== "group" || cur.run !== "running") return;
      if (cur.caps.turns >= cur.caps.maxTurns || cur.caps.cost >= cur.caps.maxCost) {
        dispatch({ type: "groupRun", chatId: g.id, run: "paused" });
        dispatch({ type: "append", chatId: g.id, message: { id: id(), kind: "system", text: "Limit reached. Paused." } });
        return;
      }
      const speaker = step < order.length ? order[step] : g.router;
      const final = step >= order.length;
      const t = teammate(speaker);
      if (!t) return;
      const text = final
        ? `Done for now. ${order.map((m) => teammate(m)?.name).join(", ")} are on it.`
        : REPLY[t.role];
      reply(g.id, speaker, text, 900 + Math.random() * 600, () => {
        dispatch({ type: "groupTurn", chatId: g.id, cost: TURN_COST });
        step += 1;
        if (final) dispatch({ type: "groupRun", chatId: g.id, run: "idle" });
        else window.setTimeout(next, 400);
      });
    };
    window.setTimeout(next, 500);
  }

  return {
    send(chatId, text, extras = {}) {
      const c = chat(chatId);
      if (!c) return;
      const mid = id();
      const files = extras.attachments?.length ? extras.attachments : undefined;
      dispatch({
        type: "append",
        chatId,
        message: { id: mid, kind: "text", from: "me", text, replyTo: extras.replyTo, attachments: files },
      });
      // Uploads finish after a short delay; the API will report real progress.
      if (files) window.setTimeout(() => dispatch({ type: "uploaded", chatId, messageId: mid }), 1200);
      if (c.kind === "group") return runGroup(c, text);
      const t = teammate(c.with);
      if (!t) return;
      // A reply to the teammate, or a message with files, is answered as a quote of it.
      const quote = extras.replyTo || files ? mid : undefined;
      const answer = files && !text ? "Got it. Looking at it now." : REPLY[t.role];
      reply(chatId, t.id, answer, files ? 1700 : 1100, undefined, quote);
    },
    decide(chatId, messageId, answer) {
      dispatch({ type: "decide", chatId, messageId, answer });
      const m = chat(chatId)?.messages.find((x) => x.id === messageId);
      if (!m || (m.kind !== "approval" && m.kind !== "question")) return;
      const ack =
        answer === "Approved" ? "Done. CI is running." : answer === "Denied" ? "Understood. Nothing changed." : "Got it. Going with that.";
      reply(chatId, m.from, ack, 900, undefined, messageId);
    },
    stopGroup(chatId) {
      window.clearTimeout(timers.get(chatId));
      dispatch({ type: "typing", chatId });
      dispatch({ type: "groupRun", chatId, run: "stopped" });
      dispatch({ type: "append", chatId, message: { id: id(), kind: "system", text: "You stopped the group." } });
    },
    retry(chatId, messageId) {
      // The fixture never fails a send; clearing the flag is the whole retry.
      dispatch({ type: "markFailed", chatId, messageId, failed: false });
    },
    createTeammate(input) {
      const tid = id();
      const chatId = `d-${tid}`;
      const greet = `Hi, I'm ${input.name}, your ${ROLE_LABEL[input.role].toLowerCase()}. Tell me what you need.`;
      dispatch({
        type: "addTeammate",
        teammate: { id: tid, ...input, avatar: ROLE_TEMPLATES[input.role].avatar, memory: "" },
        chat: {
          id: chatId,
          kind: "direct",
          with: tid,
          updatedAt: Date.now(),
          unread: false,
          messages: [
            { id: id(), kind: "stamp", text: stamp() },
            { id: id(), kind: "text", from: tid, text: greet },
          ],
        },
      });
      return chatId;
    },
    createGroup(input) {
      const chatId = `g-${id()}`;
      const routerName = teammate(input.router)?.name ?? "The router";
      dispatch({
        type: "addGroup",
        chat: {
          id: chatId,
          kind: "group",
          name: input.name,
          description: input.description,
          members: input.members,
          router: input.router,
          caps: { turns: 0, maxTurns: input.maxTurns, cost: 0, maxCost: input.maxCost },
          run: "idle",
          memory: "",
          updatedAt: Date.now(),
          unread: false,
          messages: [
            { id: id(), kind: "stamp", text: stamp() },
            {
              id: id(),
              kind: "system",
              text: `${routerName} routes this group. Limit per request: ${input.maxTurns} turns, $${input.maxCost}.`,
            },
          ],
        },
      });
      return chatId;
    },
    saveGroupMemory(chatId, memory) {
      dispatch({ type: "setGroupMemory", chatId, memory, at: Date.now() });
      dispatch({ type: "append", chatId, message: { id: id(), kind: "system", text: "You updated the group memory." } });
    },
    updateGroup(chatId, name, description) {
      const g = chat(chatId);
      if (!g || g.kind !== "group") return;
      dispatch({ type: "updateGroup", chatId, name, description });
      // Members see each change in the history, since both shape how they answer.
      const note = (text: string) => dispatch({ type: "append", chatId, message: { id: id(), kind: "system", text } });
      if (name !== g.name) note(`You renamed the group to “${name}”.`);
      if (description !== g.description) note(description ? "You updated the group description." : "You removed the group description.");
    },
    deleteGroup(chatId) {
      // A pending bot reply must not land in a chat that no longer exists.
      window.clearTimeout(timers.get(chatId));
      dispatch({ type: "removeChat", chatId });
    },
    removeTeammate(teammateId) {
      const direct = getState().chats.find((c) => c.kind === "direct" && c.with === teammateId);
      if (direct) window.clearTimeout(timers.get(direct.id));
      dispatch({ type: "removeTeammate", teammateId });
    },
    setUnread(chatId, unread) {
      dispatch({ type: "setUnread", chatId, unread });
    },
  };
}

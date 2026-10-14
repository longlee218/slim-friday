import { describe, expect, test } from "bun:test";
import type { Client, Interaction } from "discord.js";
import { createDiscordApprovalGateway } from "../src/approvals/discord-approval";
import { threadLanguage } from "../src/ingress/discord-components";
import { createMessageHandler } from "../src/ingress/discord-message-handler";
import { BUSY_ACK_EMOJI } from "../src/ingress/discord-send";
import {
  localizeUserCopy,
  pinnedThreadLanguage,
  pinThreadLanguage,
  renderUserNotice,
} from "../src/ingress/user-copy";
import { unknownLocation } from "../src/orchestrator/dispatch/task-location";
import { budgetHitMessage } from "../src/orchestrator/engine/budget";
import { openDb } from "../src/storage/db";
import { insertTurn } from "../src/storage/run-store";

/* End-to-end conversation presentation: the real message handler, receipt lifecycle and approval gateway on a
   fake Discord thread, with a fake turn layer standing in for the role/intent engine. */

const OWNER = "111";
/** Receipt delay injected into the handler (the production default is 2 s). */
const RECEIPT_MS = 100;
const BOT = "999";
const V2_FLAG = 1 << 15;
/** Orchestration words that must never reach an ordinary Discord reply. */
const JARGON = /proposal|turn[ _-]?id|task[ _-]?id|\bturn\b|\bbrief\b|Owner chose|#\d|\bstage\b/i;

/** A bot-owned thread that records sends/typing; `send` returns an editable message like discord.js. */
function fakeThread() {
  const sent: any[] = [];
  const edits: any[] = [];
  let typing = 0;
  const ch: any = {
    id: "thr1",
    sent,
    edits,
    typing: () => typing,
    isThread: () => true,
    ownerId: BOT,
    parentId: "chan",
    isSendable: () => true,
    send: async (o: any) => {
      sent.push(o);
      return { edit: async (e: any) => void edits.push(e) };
    },
    sendTyping: async () => {
      typing++;
    },
  };
  return ch;
}

/** Owner message in the thread, with reaction bookkeeping. */
function fakeMessage(channel: any, content: string) {
  const reactions: string[] = [];
  const removed: string[] = [];
  const msg: any = {
    react: async (e: string) => void reactions.push(e),
    reactions: {
      cache: new Map([
        [BUSY_ACK_EMOJI, { users: { remove: async (id: string) => void removed.push(id) } }],
      ]),
    },
    author: { id: OWNER, bot: false },
    content,
    channel,
    guildId: "G1",
    inGuild: () => true,
    mentions: { has: () => false },
    reply: async () => {},
  };
  return { msg, reactions, removed };
}

/** Gateway on the thread; the thread's language comes from the latest turn brief. */
function gatewayFor(channel: any, brief: string) {
  const db = openDb(":memory:");
  insertTurn(db, {
    id: "t1",
    threadId: "thr1",
    source: "discord",
    location: "r",
    role: "assistant",
    brief,
  });
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  const gw = createDiscordApprovalGateway({ getClient: () => client, ownerId: OWNER, db });
  const click = (customId: string) => {
    const out: any = {};
    const i = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isFromMessage: () => true,
      customId,
      channelId: "thr1",
      user: { id: OWNER },
      reply: async (r: any) => {
        out.reply = r;
      },
      update: async (u: any) => {
        out.update = u;
      },
      deferUpdate: async () => {},
    } as unknown as Interaction;
    return { run: () => gw.handleInteraction(i), out };
  };
  return { gw, click };
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const idsOf = (m: any) =>
  m.components.flatMap((r: any) => r.toJSON().components.map((c: any) => c.custom_id));

describe("Friday conversation (Vietnamese owner)", () => {
  test("greeting: one natural reply, no receipt, no leftover typing, no task jargon", async () => {
    const th = fakeThread();
    const handler = createMessageHandler({
      ownerId: OWNER,
      botId: () => BOT,
      receiptDelayMs: RECEIPT_MS,
      handleMessage: async () => "Chào bạn! Mình có thể giúp gì hôm nay?",
    });
    const m = fakeMessage(th, "chào bạn");
    await handler(m.msg);
    await Bun.sleep(RECEIPT_MS + 80); // past the receipt delay: nothing may appear late
    expect(th.sent.map((s: any) => s.content)).toEqual(["Chào bạn! Mình có thể giúp gì hôm nay?"]);
    expect(m.reactions).toEqual([]);
    expect(th.sent[0].content).not.toMatch(JARGON);
  }, 10000);

  test("delayed reply: a temporary receipt first, removed after the visible reply; typing stops", async () => {
    const th = fakeThread();
    const gate = deferred<string>();
    const handler = createMessageHandler({
      ownerId: OWNER,
      botId: () => BOT,
      receiptDelayMs: RECEIPT_MS,
      handleMessage: () => gate.promise,
    });
    const m = fakeMessage(th, "hãy kiểm tra giúp mình lỗi build");
    const pending = handler(m.msg);
    await Bun.sleep(RECEIPT_MS + 80);
    expect(m.reactions).toEqual([BUSY_ACK_EMOJI]); // acknowledges receipt only
    expect(th.sent).toEqual([]); // no invented progress text
    gate.resolve("Build lỗi do thiếu biến môi trường.");
    await pending;
    expect(th.sent.at(-1).content).toBe("Build lỗi do thiếu biến môi trường.");
    expect(m.removed).toEqual([BOT]); // reaction is not persistent
    const typingAfter = th.typing();
    await Bun.sleep(100);
    expect(th.typing()).toBe(typingAfter);
  }, 10000);

  test("choice question: selected state shows the label, no #N, controls removed", async () => {
    const th = fakeThread();
    const { gw, click } = gatewayFor(th, "Bạn hãy chọn giúp mình cách triển khai phù hợp");
    let answer: string | undefined;
    const handler = createMessageHandler({
      ownerId: OWNER,
      botId: () => BOT,
      receiptDelayMs: RECEIPT_MS,
      handleMessage: async () => {
        answer = await gw.askChoice({
          turnId: "t1",
          threadId: "thr1",
          question: "Bạn muốn làm theo hướng nào?",
          options: ["Làm ngay", "Để sau"],
        });
        return `Đã ghi nhận: ${answer}`;
      },
    });
    const pending = handler(fakeMessage(th, "triển khai tính năng mới giúp mình").msg);
    await Bun.sleep(50);
    expect(th.sent[0].content).not.toMatch(JARGON);
    const c = click(idsOf(th.sent[0])[0]);
    await c.run();
    await pending;
    expect(answer).toBe("Làm ngay");
    expect(c.out.update.content).toContain("Đã chọn: Làm ngay");
    expect(c.out.update.content).not.toMatch(/Owner chose|#\d|Chose:/);
    expect(c.out.update.components).toEqual([]);
  });

  test("Markdown report: components-v2 summary, file with verbatim Mermaid, usable link only", async () => {
    const th = fakeThread();
    const mermaid = "```mermaid\ngraph TD; A-->B\n```";
    const long = `${"Nội dung báo cáo\n".repeat(400)}${mermaid}\n[Tài liệu](https://d.example/x) [file](file:///tmp/x.md)`;
    const handler = createMessageHandler({
      ownerId: OWNER,
      botId: () => BOT,
      receiptDelayMs: RECEIPT_MS,
      handleMessage: async () => long,
    });
    await handler(fakeMessage(th, "viết báo cáo kiến trúc giúp mình").msg);
    const sent = th.sent[0];
    expect(sent.content).toBeUndefined();
    expect(sent.flags & V2_FLAG).toBe(V2_FLAG);
    const json = sent.components.map((c: any) => c.toJSON());
    expect(json[0].content).toContain("[đã đính kèm toàn bộ câu trả lời]"); // localized marker
    expect(json[0].content).not.toContain("[full reply attached]");
    expect(json.at(-1).components.map((b: any) => b.url)).toEqual(["https://d.example/x"]);
    expect(sent.files[0].attachment.toString()).toContain("graph TD; A-->B");
  });

  test("steer wording never claims an unread update was read or applied", () => {
    for (const state of ["queued", "held", "waiting", "full", "ended"] as const) {
      const vi = renderUserNotice({ kind: "steer", state }, "vi");
      expect(vi).not.toMatch(JARGON);
      // every state but the plain "passed it on" one says it is not (yet) applied
      if (state !== "queued") expect(vi).toMatch(/chưa[^.]*áp dụng/i);
    }
    expect(renderUserNotice({ kind: "steer", state: "queued" }, "vi")).not.toMatch(
      /đã (đọc|áp dụng)/,
    );
  });
});

describe("Friday conversation (English owner)", () => {
  test("choice in English and report marker in English", async () => {
    const th = fakeThread();
    const { gw, click } = gatewayFor(th, "Please pick the rollout approach that fits this change");
    const handler = createMessageHandler({
      ownerId: OWNER,
      botId: () => BOT,
      receiptDelayMs: RECEIPT_MS,
      handleMessage: async () => {
        const a = await gw.askChoice({
          turnId: "t1",
          threadId: "thr1",
          question: "Which way?",
          options: ["Now", "Later"],
        });
        return `Noted: ${a}`;
      },
    });
    const pending = handler(fakeMessage(th, "please roll out the new feature").msg);
    await Bun.sleep(50);
    const c = click(idsOf(th.sent[0])[1]);
    await c.run();
    await pending;
    expect(c.out.update.content).toContain("Chose: Later");
    expect(c.out.update.content).not.toMatch(/Owner chose|#\d/);
    expect(c.out.update.components).toEqual([]);

    const t2 = fakeThread();
    const report = createMessageHandler({
      ownerId: OWNER,
      botId: () => BOT,
      receiptDelayMs: RECEIPT_MS,
      handleMessage: async () => `${"report body line\n".repeat(400)}[Docs](https://d.example/x)`,
    });
    await report(fakeMessage(t2, "write the architecture report for me please").msg);
    expect(t2.sent[0].components[0].toJSON().content).toContain("[full reply attached]");
  });
});

describe("one conversation language and the first visible response", () => {
  /** Gateway whose db has no turn rows at all (a foreground run stores no brief). */
  function bareGateway(channel: any) {
    const db = openDb(":memory:");
    const client = { channels: { fetch: async () => channel } } as unknown as Client;
    return {
      db,
      gw: createDiscordApprovalGateway({ getClient: () => client, ownerId: OWNER, db }),
    };
  }
  const gateRequest = (message: { visible?: () => Promise<void> }) => ({
    turnId: "g1",
    threadId: "thr1",
    tool: "OwnerConfirm",
    summary: "Run it?",
    onPosted: message.visible,
  });

  test("a question posted before the receipt delay is the receipt: no reaction ever appears", async () => {
    const th = fakeThread();
    const { gw } = bareGateway(th);
    const handler = createMessageHandler({
      ownerId: OWNER,
      botId: () => BOT,
      receiptDelayMs: RECEIPT_MS,
      handleMessage: async (message) => {
        void gw.confirm(gateRequest(message), ["Yes", "No"]);
        await Bun.sleep(RECEIPT_MS + 80); // the question stays unanswered past the receipt delay
        return "done";
      },
    });
    const m = fakeMessage(th, "please run the whole test suite");
    await handler(m.msg);
    expect(th.sent[0].content).toBe("Run it?");
    expect(m.reactions).toEqual([]);
  });

  test("a question posted after a receipt appeared removes it", async () => {
    const th = fakeThread();
    const { gw } = bareGateway(th);
    const handler = createMessageHandler({
      ownerId: OWNER,
      botId: () => BOT,
      receiptDelayMs: RECEIPT_MS,
      handleMessage: async (message) => {
        await Bun.sleep(RECEIPT_MS + 80);
        void gw.confirm(gateRequest(message), ["Yes", "No"]);
        await Bun.sleep(30);
        return "done";
      },
    });
    const m = fakeMessage(th, "please run the whole test suite");
    await handler(m.msg);
    expect(m.reactions).toEqual([BUSY_ACK_EMOJI]);
    expect(m.removed).toEqual([BOT]);
  });

  test("a failed question send never settles the receipt", async () => {
    const th = fakeThread();
    th.send = async () => {
      throw new Error("send failed");
    };
    const { gw } = bareGateway(th);
    let posted = 0;
    const r = await gw.confirm(
      {
        turnId: "g1",
        threadId: "thr1",
        tool: "OwnerConfirm",
        summary: "?",
        onPosted: () => void posted++,
      },
      ["Yes", "No"],
    );
    expect(r.approved).toBe(false);
    expect(posted).toBe(0);
  });

  test("English owner with no stored brief gets English controls", async () => {
    const th = fakeThread();
    const { gw, db } = bareGateway(th);
    const handler = createMessageHandler({
      ownerId: OWNER,
      botId: () => BOT,
      receiptDelayMs: RECEIPT_MS,
      handleMessage: async () => {
        void gw.request({ turnId: "g2", threadId: "thr1", tool: "Bash", summary: "run ls" });
        await Bun.sleep(30);
        return "done";
      },
    });
    await handler(fakeMessage(th, "please list the files in this repository").msg);
    const labels = th.sent[0].components.flatMap((r: any) =>
      r.toJSON().components.map((c: any) => c.label),
    );
    expect(labels).toEqual(["Approve", "Deny"]);
    expect(threadLanguage(db, "thr1")).toBe("en");
  });

  test("the pinned language beats English headings inside a stored brief (unaccented Vietnamese)", () => {
    const db = openDb(":memory:");
    insertTurn(db, {
      id: "t9",
      threadId: "thr-pin",
      source: "discord",
      location: "r",
      role: "dev",
      brief:
        "lam tiep di\n\nEarlier tasks in this thread:\n- fix build\n\nRecent conversation (data):\n- owner: ok",
    });
    pinThreadLanguage("thr-pin", "vi");
    expect(threadLanguage(db, "thr-pin")).toBe("vi");
  });

  test("the pinned-language map is bounded: the oldest threads are dropped", () => {
    for (let n = 0; n < 700; n++) pinThreadLanguage(`cap-${n}`, "en");
    expect(pinnedThreadLanguage("cap-0")).toBeUndefined();
    expect(pinnedThreadLanguage("cap-699")).toBe("en");
  });
});

describe("remaining owner-facing notices", () => {
  test("every note renders in Vietnamese and English without task jargon", () => {
    const states = [
      "no-delivery",
      "opus-declined",
      "opus-unavailable",
      "ceiling-rerun",
      "escalated-opus",
      "escalated-sonnet",
      "resume-task-lost",
      "resume-cleared",
      "cannot-resume",
      "stale-resume",
      "budget-stop",
      "empty-text",
      "stop-in-thread",
      "status-in-thread",
      "not-allowed",
      "channel-unavailable",
      "proposal-pending",
      "proposal-queued",
    ] as const;
    for (const state of states) {
      const vi = renderUserNotice({ kind: "note", state }, "vi");
      const en = renderUserNotice({ kind: "note", state }, "en");
      expect(vi).not.toBe(en);
      expect(vi).not.toMatch(/\b(task|queued|proposal|ceiling|session)\b/i);
      expect(localizeUserCopy(en, "vi")).toBe(vi); // deep English renders are localized at the boundary
    }
  });

  test("unknown location lists the valid names, localized", () => {
    const refusal = unknownLocation([{ name: "app" }, { name: "docs" }] as never);
    expect(refusal.reply).toContain("app, docs");
    expect(localizeUserCopy(refusal.reply, "vi")).toContain("Các nơi hợp lệ: app, docs");
  });

  test("a ceiling-bound budget stop says what to do next", () => {
    const text = budgetHitMessage({ ceilingBound: true }, "vi");
    expect(text).toContain("yêu cầu mới");
  });
});

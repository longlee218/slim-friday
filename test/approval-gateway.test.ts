import { describe, expect, test } from "bun:test";
import type { Client, Interaction } from "discord.js";
import { createDiscordApprovalGateway } from "../src/approvals/discord-approval";
import { openDb } from "../src/storage/db";
import { insertTurn } from "../src/storage/run-store";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";

const OWNER = "owner1";
const FAKE_TOKEN = "sk-ant-abcdefghijklmnop1234";
/** Thread language comes from the latest task brief. */
const EN_BRIEF = "Please run the tests in this repository and tell me what failed";
const VI_BRIEF = "Bạn hãy chạy các bài kiểm tra trong kho mã này và cho mình biết kết quả";

/** Fake thread channel recording sent payloads; customIds are read from the components. */
function setup(timeoutMs = 5000, sendable = true, brief = EN_BRIEF) {
  const sent: any[] = [];
  const edits: any[] = [];
  const channel = {
    isSendable: () => sendable,
    send: async (p: any) => {
      sent.push(p);
      return { edit: async (e: any) => void edits.push(e) };
    },
  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  const db = openDb(":memory:");
  insertTurn(db, {
    id: "t1",
    threadId: "th",
    source: "discord",
    location: "r",
    role: "assistant",
    brief,
  });
  const gw = createDiscordApprovalGateway({
    getClient: () => client,
    ownerId: OWNER,
    db,
    timeoutMs,
  });
  const ids = () =>
    sent.at(-1).components.flatMap((r: any) => r.toJSON().components.map((c: any) => c.custom_id));
  /** Fake interaction of any kind; records replies/updates/modals and the order of ACK calls. */
  const interact = (
    kind: "button" | "select" | "modal",
    customId: string,
    extra: { values?: string[]; typed?: string; userId?: string; fromMessage?: boolean } = {},
  ) => {
    const out: any = { order: [] as string[] };
    const i = {
      isButton: () => kind === "button",
      isStringSelectMenu: () => kind === "select",
      isModalSubmit: () => kind === "modal",
      isFromMessage: () => extra.fromMessage ?? true,
      customId,
      channelId: "th",
      user: { id: extra.userId ?? OWNER },
      values: extra.values,
      fields: { getTextInputValue: () => extra.typed ?? "" },
      reply: async (r: any) => {
        out.order.push("reply");
        out.reply = r;
      },
      update: async (u: any) => {
        out.order.push("update");
        out.update = u;
      },
      deferUpdate: async () => {
        out.order.push("defer");
        out.deferred = true;
      },
      showModal: async (m: any) => {
        out.order.push("modal");
        out.modal = m;
      },
    } as unknown as Interaction;
    return { run: () => gw.handleInteraction(i), out };
  };
  const click = (customId: string, userId = OWNER) => interact("button", customId, { userId });
  const row = (sql: string) => db.query(sql).get() as any;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { gw, sent, edits, db, ids, click, interact, row, tick };
}

const req = { turnId: "t1", threadId: "th", tool: BASH_TOOL_NAME, summary: "run ls" };

describe("discord approval gateway", () => {
  test("approve resolves, persists, task waiting then running", async () => {
    const s = setup();
    const p = s.gw.request(req);
    await s.tick();
    expect(s.row("SELECT status FROM turns").status).toBe("waiting_approval");
    expect(s.row("SELECT decision FROM approvals").decision).toBe("pending");
    const c = s.click(s.ids()[0]);
    await c.run();
    expect(await p).toEqual({ approved: true });
    expect(c.out.update.components).toEqual([]);
    expect(c.out.update.content).toContain("Chose: Approve");
    expect(s.row("SELECT status FROM turns").status).toBe("running");
    const a = s.row("SELECT * FROM approvals");
    expect(a.decision).toBe("approved");
    expect(a.tool).toBe(BASH_TOOL_NAME);
    expect(a.decided_at).not.toBeNull();
  });

  test("deny", async () => {
    const s = setup();
    const p = s.gw.request(req);
    await s.tick();
    await s.click(s.ids()[1]).run();
    expect(await p).toEqual({ approved: false, reason: "owner denied" });
    expect(s.row("SELECT decision FROM approvals").decision).toBe("denied");
  });

  test("non-owner click ignored, owner then resolves", async () => {
    const s = setup();
    const p = s.gw.request(req);
    await s.tick();
    const bad = s.click(s.ids()[0], "intruder");
    await bad.run();
    expect(bad.out.reply.content).toBe("Only the owner can approve.");
    expect(bad.out.reply.flags).toBeDefined();
    expect(s.row("SELECT decision FROM approvals").decision).toBe("pending");
    await s.click(s.ids()[0]).run();
    expect((await p).approved).toBe(true);
  });

  test("timeout denies and edits message", async () => {
    const s = setup(20);
    const r = await s.gw.request(req);
    expect(r).toEqual({ approved: false, reason: "timeout" });
    expect(s.row("SELECT decision FROM approvals").decision).toBe("timeout");
    expect(s.row("SELECT status FROM turns").status).toBe("running");
    expect(s.edits[0].components).toEqual([]);
    expect(s.edits[0].content).toContain("Timed out");
  });

  test("askChoice returns chosen label; timeout undefined", async () => {
    const s = setup();
    const p = s.gw.askChoice({
      turnId: "t1",
      threadId: "th",
      question: "which?",
      options: ["a", "b"],
    });
    await s.tick();
    await s.click(s.ids()[1]).run();
    expect(await p).toBe("b");
    const t = setup(20);
    expect(
      await t.gw.askChoice({ turnId: "t1", threadId: "th", question: "q", options: ["x"] }),
    ).toBeUndefined();
  });

  test("a long question (a plan to approve) goes out as an attachment under a short stem; a short one stays inline", async () => {
    const s = setup();
    const plan = `Plan: ${"step. ".repeat(600)} token=${FAKE_TOKEN}`; // far over one Discord message
    const p = s.gw.askChoice({
      turnId: "t1",
      threadId: "th",
      question: plan,
      options: ["Approve", "Revise"],
    });
    await s.tick();
    const msg = s.sent[0];
    expect(msg.content.length).toBeLessThan(500); // the stem, not the plan
    expect(msg.content).toContain("Plan: step.");
    expect(msg.content).toContain("full text in the attached file");
    expect(msg.files).toHaveLength(1);
    expect(msg.files[0].name).toBe("AskUserQuestion-detail.txt");
    const text = msg.files[0].attachment.toString();
    expect(text.length).toBeGreaterThan(3000); // the whole plan
    expect(text).not.toContain(FAKE_TOKEN); // redacted like every attachment
    expect(msg.components).toHaveLength(1); // the buttons are on the stem message
    await s.click(s.ids()[0]).run();
    expect(await p).toBe("Approve");
    // a short question: inline, no attachment
    const t = setup();
    const q = t.gw.askChoice({ turnId: "t1", threadId: "th", question: "which?", options: ["a"] });
    await t.tick();
    expect(t.sent[0].content).toBe("which?");
    expect(t.sent[0].files).toEqual([]);
    await t.click(t.ids()[0]).run();
    await q;
  });

  test("redacts summary (message + db) and detail attachment", async () => {
    const s = setup(20);
    await s.gw.request({ ...req, summary: `use ${FAKE_TOKEN}`, detail: `full ${FAKE_TOKEN}` });
    expect(s.sent[0].content).not.toContain(FAKE_TOKEN);
    expect(s.row("SELECT summary FROM approvals").summary).not.toContain(FAKE_TOKEN);
    const file = s.sent[0].files[0];
    expect(file.attachment.toString()).not.toContain(FAKE_TOKEN);
    expect(s.sent[0].allowedMentions.parse).toEqual([]);
  });

  test("unknown id gets expired reply; foreign customId ignored", async () => {
    const s = setup();
    const c = s.click("appr:nope:allow");
    expect(s.sent).toHaveLength(0);
    await c.run();
    expect(c.out.reply.content).toContain("expired");
    const other = s.click("other:x:y");
    await other.run();
    expect(other.out.reply).toBeUndefined();
  });

  test("unsendable channel denies with no channel", async () => {
    const s = setup(5000, false);
    expect(await s.gw.request(req)).toEqual({ approved: false, reason: "no channel" });
    expect(s.row("SELECT status FROM turns").status).toBe("running");
  });
});

describe("confirm (custom labels)", () => {
  const labels: [string, string] = ["Create PR", "Skip"];
  const buttonLabels = (s: ReturnType<typeof setup>) =>
    s.sent.at(-1).components.flatMap((r: any) => r.toJSON().components.map((c: any) => c.label));

  test("approve shows custom labels and resolves approved", async () => {
    const s = setup();
    const p = s.gw.confirm(req, labels);
    await s.tick();
    expect(buttonLabels(s)).toEqual(labels);
    await s.click(s.ids()[0]).run();
    expect(await p).toEqual({ approved: true });
    expect(s.row("SELECT decision FROM approvals").decision).toBe("approved");
  });

  test("decline reason is owner declined", async () => {
    const s = setup();
    const p = s.gw.confirm(req, labels);
    await s.tick();
    await s.click(s.ids()[1]).run();
    expect(await p).toEqual({ approved: false, reason: "owner declined" });
    expect(s.row("SELECT decision FROM approvals").decision).toBe("denied");
  });

  test("timeout denies", async () => {
    const s = setup(20);
    expect(await s.gw.confirm(req, labels)).toEqual({ approved: false, reason: "timeout" });
    expect(s.row("SELECT decision FROM approvals").decision).toBe("timeout");
  });
});

describe("cancelTurn (run aborted while waiting)", () => {
  test("drops open requests, records cancelled, never flips the task back to running", async () => {
    const s = setup();
    const p = s.gw.request(req);
    await s.tick();
    s.db.run("UPDATE turns SET status = 'cancelled' WHERE id = 't1'"); // handler ended the task
    s.gw.cancelTurn("t1");
    expect(await p).toEqual({ approved: false, reason: "cancelled" });
    expect(s.row("SELECT decision FROM approvals").decision).toBe("cancelled");
    expect(s.row("SELECT status FROM turns").status).toBe("cancelled");
    expect(s.edits.at(-1).content).toContain("Cancelled");
    // A late click on the dead request is "expired", not approved.
    const c = s.click(s.ids()[0]);
    await c.run();
    expect(c.out.reply.content).toContain("expired");
    expect(s.row("SELECT decision FROM approvals").decision).toBe("cancelled");
  });
});

describe("natural choices", () => {
  const ask = (s: ReturnType<typeof setup>, options: string[], question = "which?") =>
    s.gw.askChoice({ turnId: "t1", threadId: "th", question, options });
  const kinds = (s: ReturnType<typeof setup>) =>
    s.sent.at(-1).components.flatMap((r: any) => r.toJSON().components.map((c: any) => c.type));
  const ids = (s: ReturnType<typeof setup>) =>
    s.sent
      .at(-1)
      .components.flatMap((r: any) => r.toJSON().components.map((c: any) => c.custom_id));
  const SELECT = 3;
  const BUTTON = 2;
  const many = Array.from({ length: 8 }, (_, n) => `option ${n}`);

  test("a button pick shows the label, never its number, and drops the controls", async () => {
    const s = setup();
    const p = ask(s, ["Ship it", "Wait"]);
    await s.tick();
    const c = s.click(s.ids()[0]);
    await c.run();
    expect(await p).toBe("Ship it");
    expect(c.out.update.content).toContain("Chose: Ship it");
    expect(c.out.update.content).not.toContain("#");
    expect(c.out.update.content).not.toContain("Owner chose");
    expect(c.out.update.components).toEqual([]);
  });

  test("selected state is in Vietnamese when the thread speaks Vietnamese", async () => {
    const s = setup(5000, true, VI_BRIEF);
    const p = ask(s, ["Có", "Không"]);
    await s.tick();
    const c = s.click(s.ids()[1]);
    await c.run();
    expect(await p).toBe("Không");
    expect(c.out.update.content).toContain("Đã chọn: Không");
  });

  test("6 to 25 options use a select menu plus the Enter answer button; component ids hold only ids", async () => {
    const s = setup();
    const p = ask(s, many, "secret question text");
    await s.tick();
    expect(kinds(s)).toEqual([SELECT, BUTTON]);
    for (const id of ids(s)) expect(id).toMatch(/^choice:[0-9a-f-]{8}:[a-z0-9]+$/);
    const c = s.interact("select", ids(s)[0], { values: ["4"] });
    await c.run();
    expect(await p).toBe("option 4");
    expect(c.out.update.content).toContain("Chose: option 4");
    expect(c.out.update.components).toEqual([]);
  });

  test("Enter answer opens a modal; the submitted text is the answer", async () => {
    const s = setup();
    const p = ask(s, many);
    await s.tick();
    const enter = s.click(ids(s)[1]);
    await enter.run();
    expect(enter.out.order).toEqual(["modal"]);
    expect(s.row("SELECT decision FROM approvals").decision).toBe("pending"); // nothing settled yet
    const modalId = enter.out.modal.toJSON().custom_id;
    const sub = s.interact("modal", modalId, { typed: "  something else  " });
    await sub.run();
    expect(await p).toBe("something else");
    expect(sub.out.update.content).toContain("Answered: something else");
    expect(sub.out.update.components).toEqual([]);
  });

  test("a free-form question (no options) has only the Enter answer button", async () => {
    const s = setup();
    const p = ask(s, []);
    await s.tick();
    expect(kinds(s)).toEqual([BUTTON]);
    const enter = s.click(ids(s)[0]);
    await enter.run();
    await s.interact("modal", enter.out.modal.toJSON().custom_id, { typed: "free text" }).run();
    expect(await p).toBe("free text");
  });

  test("more than 25 options: full list in the attachment, typed answer only", async () => {
    const s = setup();
    const big = Array.from({ length: 30 }, (_, n) => `choice ${n}`);
    const p = ask(s, big);
    await s.tick();
    expect(kinds(s)).toEqual([BUTTON]);
    expect(s.sent[0].files[0].attachment.toString()).toContain("- choice 29");
    const enter = s.click(ids(s)[0]);
    await enter.run();
    await s.interact("modal", enter.out.modal.toJSON().custom_id, { typed: "choice 3" }).run();
    expect(await p).toBe("choice 3");
  });

  test("a typed answer is redacted in the settled message but returned whole", async () => {
    const s = setup();
    const p = ask(s, []);
    await s.tick();
    const enter = s.click(ids(s)[0]);
    await enter.run();
    const sub = s.interact("modal", enter.out.modal.toJSON().custom_id, {
      typed: `key ${FAKE_TOKEN}`,
    });
    await sub.run();
    expect(await p).toBe(`key ${FAKE_TOKEN}`);
    expect(sub.out.update.content).not.toContain(FAKE_TOKEN);
  });

  test("a blank modal answer keeps the question open", async () => {
    const s = setup(5000);
    const p = ask(s, []);
    await s.tick();
    const enter = s.click(ids(s)[0]);
    await enter.run();
    const sub = s.interact("modal", enter.out.modal.toJSON().custom_id, { typed: "   " });
    await sub.run();
    expect(sub.out.deferred).toBe(true);
    s.gw.cancelTurn("t1");
    expect(await p).toBeUndefined();
  });

  test("non-owner select and modal are refused; stale ids are expired and mutate nothing", async () => {
    const s = setup();
    const p = ask(s, many);
    await s.tick();
    const bad = s.interact("select", ids(s)[0], { values: ["0"], userId: "intruder" });
    await bad.run();
    expect(bad.out.reply.content).toBe("Only the owner can approve.");
    const badModal = s.interact("modal", ids(s)[0].replace(/:s$/, ":m"), {
      typed: "x",
      userId: "intruder",
    });
    await badModal.run();
    expect(badModal.out.reply.content).toBe("Only the owner can approve.");
    expect(s.row("SELECT decision FROM approvals").decision).toBe("pending");
    const stale = s.interact("select", "choice:deadbeef:s", { values: ["0"] });
    await stale.run();
    expect(stale.out.reply.content).toBe("This action expired.");
    const staleEnter = s.click("choice:deadbeef:a");
    await staleEnter.run();
    expect(staleEnter.out.modal).toBeUndefined();
    s.gw.cancelTurn("t1");
    await p;
  });

  test("a select or modal cannot approve a tool call", async () => {
    const s = setup();
    const p = s.gw.request(req);
    await s.tick();
    const sel = s.interact("select", s.ids()[0], { values: ["0"] });
    await sel.run();
    const mod = s.interact("modal", s.ids()[0], { typed: "ok" });
    await mod.run();
    expect(sel.out.order).toEqual([]);
    expect(mod.out.order).toEqual([]);
    expect(s.row("SELECT decision FROM approvals").decision).toBe("pending");
    s.gw.cancelTurn("t1");
    await p;
  });

  test("the interaction is ACKed before the request settles", async () => {
    const s = setup();
    const p = ask(s, ["a", "b"]);
    await s.tick();
    let settledAtAck: unknown = "unset";
    let done = false;
    void p.then(() => {
      done = true;
    });
    const c = s.click(s.ids()[0]);
    const origRun = c.run;
    // Probe: at the moment update() runs, the waiter must not be resolved yet.
    const upd = c.out;
    Object.defineProperty(upd, "update", {
      set(v) {
        settledAtAck = done;
        Object.defineProperty(upd, "_u", { value: v, configurable: true });
      },
      get() {
        return (upd as any)._u;
      },
      configurable: true,
    });
    await origRun();
    expect(await p).toBe("a");
    expect(settledAtAck).toBe(false);
  });

  test("timeout and cancellation drop the controls with a natural line", async () => {
    const s = setup(20, true, VI_BRIEF);
    expect(await ask(s, many)).toBeUndefined();
    expect(s.edits[0].components).toEqual([]);
    expect(s.edits[0].content).toContain("Đã hết thời gian chờ");
    const t = setup();
    const p = ask(t, ["a", "b"]);
    await t.tick();
    t.gw.cancelTurn("t1");
    expect(await p).toBeUndefined();
    expect(t.edits.at(-1).components).toEqual([]);
    expect(t.edits.at(-1).content).toContain("Cancelled");
  });
});

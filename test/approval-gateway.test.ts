import { describe, expect, test } from "bun:test";
import type { Client, Interaction } from "discord.js";
import { createDiscordApprovalGateway } from "../src/approvals/discord-approval";
import { openDb } from "../src/storage/db";
import { insertTurn } from "../src/storage/run-store";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";

const OWNER = "owner1";
const FAKE_TOKEN = "sk-ant-abcdefghijklmnop1234";

/** Fake thread channel recording sent payloads; customIds are read from the components. */
function setup(timeoutMs = 5000, sendable = true) {
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
  insertTurn(db, { id: "t1", threadId: "th", source: "discord", location: "r", role: "assistant" });
  const gw = createDiscordApprovalGateway({
    getClient: () => client,
    ownerId: OWNER,
    db,
    timeoutMs,
  });
  const ids = () =>
    sent.at(-1).components.flatMap((r: any) => r.toJSON().components.map((c: any) => c.custom_id));
  /** Fake button click; records replies/updates. */
  const click = (customId: string, userId = OWNER) => {
    const out: any = {};
    const i = {
      isButton: () => true,
      customId,
      user: { id: userId },
      reply: async (r: any) => {
        out.reply = r;
      },
      update: async (u: any) => {
        out.update = u;
      },
    } as unknown as Interaction;
    return { run: () => gw.handleInteraction(i), out };
  };
  const row = (sql: string) => db.query(sql).get() as any;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { gw, sent, edits, db, ids, click, row, tick };
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
    expect(c.out.update.content).toContain("approved");
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

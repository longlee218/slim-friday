import { describe, expect, test } from "bun:test";
import type { Client, Interaction } from "discord.js";
import { createDiscordApprovalGateway } from "../src/approvals/discord-approval";
import {
  OWNER_CONFIRM_APPROVAL,
  ownerConfirm,
  ownerConfirmLabels,
} from "../src/orchestrator/engine/owner-confirm";
import { runRoute } from "../src/orchestrator/message-routing";
import { EffortFloors } from "../src/orchestrator/thread/effort-floor";
import { MAX_DECLINED_NOTICE, settleMaxEffort } from "../src/orchestrator/thread/max-effort-gate";
import { turnEffort } from "../src/orchestrator/thread/turn-effort";
import { openDb } from "../src/storage/db";

const OWNER = "owner1";
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Real gateway over a fake thread channel; clicks are fake interactions. */
function setup(timeoutMs = 5000) {
  const sent: any[] = [];
  const channel = {
    isSendable: () => true,
    send: async (p: any) => {
      sent.push(p);
      return { edit: async () => undefined };
    },
  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  const db = openDb(":memory:");
  const make = () =>
    createDiscordApprovalGateway({ getClient: () => client, ownerId: OWNER, db, timeoutMs });
  const gw = make();
  const ids = () =>
    sent.at(-1).components.flatMap((r: any) => r.toJSON().components.map((c: any) => c.custom_id));
  const click = (g: typeof gw, customId: string) => {
    const out: any = {};
    const i = {
      isButton: () => true,
      customId,
      user: { id: OWNER },
      reply: async (r: any) => {
        out.reply = r;
      },
      update: async (u: any) => {
        out.update = u;
      },
    } as unknown as Interaction;
    return g.handleInteraction(i).then(() => out);
  };
  return { gw, make, db, sent, ids, click };
}

const req = (signal?: AbortSignal) => ({
  kind: "max_effort",
  turnId: "t-1",
  threadId: "th",
  summary: "Run at max?",
  language: "en" as const,
  signal,
});

describe("owner-confirm labels", () => {
  test("follow the owner's language", () => {
    expect(ownerConfirmLabels("vi")).toEqual(["Có, chạy đi", "Không"]);
    expect(ownerConfirmLabels("en")).toEqual(["Yes, run it", "No"]);
  });
});

describe("owner-confirm gate", () => {
  test("yes -> true; the row carries the OwnerConfirm label and the buttons are approval buttons", async () => {
    const s = setup();
    const p = ownerConfirm(s.gw, req());
    await tick();
    expect(s.sent[0].components[0].toJSON().components.map((c: any) => c.label)).toEqual([
      "Yes, run it",
      "No",
    ]);
    const yes = s.ids().find((id: string) => id.endsWith(":allow"));
    expect(yes).toMatch(/^appr:[0-9a-f]{8}:allow$/);
    await s.click(s.gw, yes);
    expect(await p).toBe(true);
    const row = s.db.query("SELECT tool, decision FROM approvals").get() as any;
    expect(row).toEqual({ tool: OWNER_CONFIRM_APPROVAL, decision: "approved" });
  });

  test("no -> false", async () => {
    const s = setup();
    const p = ownerConfirm(s.gw, req());
    await tick();
    await s.click(
      s.gw,
      s.ids().find((id: string) => id.endsWith(":deny")),
    );
    expect(await p).toBe(false);
  });

  test("timeout -> false (fails closed)", async () => {
    const s = setup(20);
    expect(await ownerConfirm(s.gw, req())).toBe(false);
    expect((s.db.query("SELECT decision FROM approvals").get() as any).decision).toBe("timeout");
  });

  test("click after a restart (fresh gateway) is expired and does nothing", async () => {
    const s = setup(30);
    const p = ownerConfirm(s.gw, req());
    await tick();
    const yes = s.ids().find((id: string) => id.endsWith(":allow"));
    const restarted = s.make(); // new process: no pending clicks
    const out = await s.click(restarted, yes);
    expect(out.reply.content).toBe("This action expired.");
    expect(out.update).toBeUndefined();
    expect(await p).toBe(false); // the original wait never got a yes
  });

  test("no approval flow, aborted signal, stop while waiting -> false", async () => {
    expect(await ownerConfirm(undefined, req())).toBe(false);
    const s = setup();
    const done = new AbortController();
    done.abort();
    expect(await ownerConfirm(s.gw, req(done.signal))).toBe(false);
    expect(s.sent.length).toBe(0);
    const ac = new AbortController();
    const p = ownerConfirm(s.gw, req(ac.signal));
    await tick();
    ac.abort();
    expect(await p).toBe(false);
  });

  test("a gateway that throws -> false", async () => {
    const gw = {
      confirm: async () => {
        throw new Error("boom");
      },
      cancelTurn: () => undefined,
    } as any;
    expect(await ownerConfirm(gw, req())).toBe(false);
  });
});

describe("max effort through the gate", () => {
  const signals = {
    floorDelta: 0,
    turnDelta: 0,
    minEffort: "max" as const,
    lookup: false,
    ruleIds: [],
  };
  const fake = (approved: boolean) =>
    ({ confirm: async () => ({ approved }), cancelTurn: () => undefined }) as any;
  const run = async (approved: boolean) => {
    const floors = new EffortFloors();
    const turn = turnEffort(floors, "th", undefined, signals);
    expect(turn).toEqual({ effort: "high", pendingMax: true });
    return settleMaxEffort({
      approvals: fake(approved),
      floors,
      threadId: "th",
      language: "en" as const,
      cls: undefined,
      signals,
      turn,
      signal: new AbortController().signal,
    });
  };

  test("yes -> max, routed to Opus", async () => {
    const r = await run(true);
    expect(r.declined).toBe(false);
    expect(r.turn.effort).toBe("max");
    const route = runRoute({ effort: r.turn.effort });
    expect(route?.ownerConfirmedMax).toBe(true);
  });

  test("no / timeout -> stays high, declined", async () => {
    const r = await run(false);
    expect(r.declined).toBe(true);
    expect(r.turn.effort).toBe("high");
    expect(runRoute({ effort: r.turn.effort })?.ownerConfirmedMax).toBeUndefined();
    expect(MAX_DECLINED_NOTICE).toContain("high");
  });
});

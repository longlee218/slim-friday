import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PLAN_HISTORY_ARG, parseSlash } from "../src/commands/slash-commands";
import { SLASH_DEFINITIONS, slashPayload, slashText } from "../src/commands/slash-definitions";
import { PLAN_GOAL_BUDGET_MAX_USD } from "../src/config/model-routing";
import { DIGEST_FLOOR_MS } from "../src/config/resilience-caps";
import type { ViewerConfig } from "../src/config/viewer-config";
import { renderDigest } from "../src/ingress/digest-copy";
import { type PlanFacts, renderPlanFacts } from "../src/ingress/plan-copy";
import { renderUserNotice } from "../src/ingress/user-copy";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import type { LeadRuntime, LeadThreadCtx } from "../src/orchestrator/lead/lead-runtime";
import { planUrlOfGoal, syncPlanArtifacts } from "../src/orchestrator/plan/plan-artifact";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { revisionNotice } from "../src/orchestrator/plan/plan-revised";
import { createPlanLookup } from "../src/orchestrator/turns/plan-live";
import { createCheckIn } from "../src/orchestrator/worker/check-in";
import { digestFacts, factsKey } from "../src/orchestrator/worker/digest-facts";
import { workerAppCtx } from "../src/orchestrator/worker/worker-app-ctx";
import { createSlashHandler } from "../src/providers/discord/ingress/slash-interaction";
import { listByGoal } from "../src/storage/artifact-store";
import { recordBotThread } from "../src/storage/thread-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { verifyLink } from "../src/viewer/signed-link";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { createPlanHandlerFor, plannerCtxOf } from "./plan-visibility-helpers";
import { byKey, ENV, item, setStoredBudget, TH } from "./waves-fixture";

/* Phase 5: plan versions as artifacts, the one-line revision notice with the viewer link, /plan, planUrl, digest. */

const VIEWER: ViewerConfig = {
  port: 1,
  baseUrl: "https://v.example",
  secret: "s".repeat(32),
  linkTtlMs: 3_600_000,
};
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};

let db: Database;
afterEach(() => db?.close());

/** A real home with a mapped channel, a thread on it and a goal with a plan v1 (`valid`, or approved). */
function world(o: { approve?: boolean; viewer?: boolean } = {}) {
  const env = makeEnv();
  db = env.db;
  recordBotThread(db, TH, TEST_CHANNEL, "main", "x");
  const w = createPlanPort(db, TH).requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "build it",
    items: [item("a"), item("b")],
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  setStoredBudget(db, r.plan.id, 1, PLAN_GOAL_BUDGET_MAX_USD); // at the ceiling: an added item applies at once
  if (o.approve) approveVersion(db, r.plan.id, 1);
  const deps = { db, home: env.home, ...(o.viewer !== false && { viewer: VIEWER }) };
  return { env, goalId: w.goalId, planId: r.plan.id, deps };
}

test("every version is an artifact of the channel, created once, rewritten when its status moves", () => {
  const { goalId, planId, deps } = world();
  const v1 = syncPlanArtifacts(deps, TH, goalId);
  expect(v1).toHaveLength(1);
  expect(v1[0]?.artifactId).toBeString();
  const row = listByGoal(db, goalId)[0]!;
  expect(row).toMatchObject({ workspace: "main", kind: "md", origin: "store" });
  expect(readFileSync(row.path, "utf8")).toContain("Status: valid");
  // The owner rejects: the same artifact now says so (no second row, no second file).
  rejectVersion(db, planId, 1, "owner rejected");
  const again = syncPlanArtifacts(deps, TH, goalId);
  expect(again[0]?.artifactId).toBe(v1[0]?.artifactId ?? "");
  expect(listByGoal(db, goalId)).toHaveLength(1);
  const text = readFileSync(row.path, "utf8");
  expect(text).toContain("Status: rejected. Reason: owner rejected");
  expect(text).toContain("Done when:");
});

test("an approved version shows the live status of each item", () => {
  const { goalId, deps } = world({ approve: true });
  moveTaskTo(db, byKey(db, goalId, "a").id, "running");
  syncPlanArtifacts(deps, TH, goalId);
  const text = readFileSync(listByGoal(db, goalId)[0]!.path, "utf8");
  expect(text).toMatch(/1\. a .*running\]/);
  expect(text).not.toContain("Approving runs");
});

test("the link is signed and opens the current version; no viewer = no link, artifact still saved", () => {
  const { goalId, deps } = world({ approve: true });
  const url = planUrlOfGoal(deps, TH, goalId)!;
  const u = new URL(url);
  const id = u.pathname.split("/").pop()!;
  expect(id).toBe(listByGoal(db, goalId)[0]!.id);
  expect(verifyLink(VIEWER.secret, id, u.searchParams.get("e"), u.searchParams.get("s"))).toBe(
    true,
  );
  expect(planUrlOfGoal({ ...deps, viewer: undefined }, TH, goalId)).toBeUndefined();
  expect(listByGoal(db, goalId)).toHaveLength(1);
});

test("an unmapped thread saves no artifact and gives no link, nothing throws", () => {
  const { goalId, deps } = world();
  db.query("UPDATE threads SET channel_id = '999' WHERE thread_id = ?").run(TH);
  expect(syncPlanArtifacts(deps, TH, goalId)[0]?.artifactId).toBeNull();
  expect(planUrlOfGoal(deps, TH, goalId)).toBeUndefined();
});

/** Worker tool ctx over a real runtime stub; returns the planner's plan ctx and what the thread received. */
function plannerCtx(viewer: boolean) {
  const { env, goalId, planId, deps } = world({ approve: true, viewer });
  const posts: { text: string; links?: { label: string; url: string }[] }[] = [];
  const ctx = {
    workspace: "main",
    channel: "main-agent",
    channelId: TEST_CHANNEL,
    locations: ENV.locations.map((name) => ({ name, path: `/x/${name}` })),
    message: {
      notify: async (text: string, o?: { links?: { label: string; url: string }[] }) => {
        posts.push({ text, ...(o?.links && { links: o.links }) });
      },
    },
  } as unknown as LeadThreadCtx;
  const rt = {
    deps: { db, config: { ...env.config, ...(viewer && { viewer: VIEWER }) } },
  } as unknown as LeadRuntime;
  const app = workerAppCtx(rt, ctx, {
    threadId: TH,
    goalId,
    itemId: "i",
    turnId: "t",
    role: "planner",
    language: "en",
    envelope: {} as never,
    sink: {} as never,
  })();
  return { app: app.plan!, posts, goalId, planId, deps };
}

test("a revision posts ONE line 'Plan v1 → v2: +a, −b, ~c' with the viewer link, and no old-style text", async () => {
  const { app, posts, planId } = plannerCtx(true);
  const r = createPlanHandlerFor(app, planId, { add: [item("z")], cancel: ["b"] });
  expect(r).toMatchObject({ ok: true, status: "approved" });
  await new Promise((res) => setTimeout(res, 10));
  expect(posts).toHaveLength(1);
  expect(posts[0]?.text).toBe("Plan v1 → v2: +1, −1, ~0 (cancelled: b)");
  expect(posts[0]?.text).not.toContain("The plan changed");
  expect(posts[0]?.links?.[0]?.url).toStartWith("https://v.example/a/");
});

test("a routine revision (only an addition) is announced too; without the viewer there is no link", async () => {
  const { app, posts, planId } = plannerCtx(false);
  createPlanHandlerFor(app, planId, { add: [item("z")] });
  await new Promise((res) => setTimeout(res, 10));
  expect(posts).toHaveLength(1);
  expect(posts[0]?.text).toBe("Plan v1 → v2: +1, −0, ~0");
  expect(posts[0]?.links ?? []).toEqual([]);
});

test("a version waiting for the owner is saved as an artifact but not announced", async () => {
  const { app, posts, planId, goalId } = plannerCtx(true);
  // A new location grows the envelope: the owner must approve (valid).
  const r = createPlanHandlerFor(app, planId, {
    add: [item("z", { location: "docs" })],
    grow: true,
  });
  expect(r).toMatchObject({ ok: true, status: "valid" });
  await new Promise((res) => setTimeout(res, 10));
  expect(posts).toHaveLength(0);
  expect(
    listByGoal(db, goalId)
      .map((a) => a.title)
      .sort(),
  ).toHaveLength(2);
});

test("a re-plan after a reject uses the same line (the code verify/fix items post nothing)", async () => {
  const { app, posts, goalId, planId } = plannerCtx(true);
  moveTaskTo(db, byKey(db, goalId, "a").id, "running");
  db.query("UPDATE work_plans SET status = 'rejected' WHERE id = ?").run(planId);
  const r = createPlanHandlerFor(app, planId, { replan: [item("n")] });
  expect(r).toMatchObject({ ok: true, version: 2 });
  await new Promise((res) => setTimeout(res, 10));
  expect(posts.map((p) => p.text)).toEqual(["Plan v1 → v2: +1, −2, ~0 (cancelled: a, b)"]);
});

test("the notice is localized and short", () => {
  const n = revisionNotice({
    from: 2,
    version: 3,
    added: ["x"],
    cancelled: [],
    modified: ["y", "z"],
    criteriaChanged: true,
    reason: "r",
  });
  expect(renderUserNotice(n, "en")).toBe(
    'Plan v2 → v3: +1, −0, ~2; the "done when" criteria changed',
  );
  expect(renderUserNotice(n, "vi")).toStartWith("Kế hoạch v2 → v3: +1, −0, ~2");
});

/** A fake `/plan` interaction in a thread. */
function fakePlan(userId: string, view?: string) {
  const replies: any[] = [];
  const i: any = {
    id: "I1",
    commandName: "plan",
    user: { id: userId, bot: false },
    channelId: TH,
    channel: undefined,
    isChatInputCommand: () => true,
    options: { get: (n: string) => (n === "view" && view ? { value: view } : null) },
    reply: async (o: any) => void replies.push(o),
    deferReply: async () => {},
    editReply: async () => {},
  };
  return { i, replies };
}

test("/plan is registered with an optional history choice", () => {
  expect(parseSlash("/plan")).toEqual({ name: "plan", arg: "" });
  expect(parseSlash(`/plan ${PLAN_HISTORY_ARG}`)).toEqual({ name: "plan", arg: "history" });
  expect(SLASH_DEFINITIONS.plan.arg?.required).toBe(false);
  const opt = slashPayload().find((c) => c.name === "plan")?.options[0] as any;
  expect(opt.choices.map((c: any) => c.value)).toEqual(["history"]);
  expect(slashText("plan", (a) => (a === "view" ? "history" : null))).toBe("/plan history");
});

test("/plan: owner only, private reply with version, item status and link; history lists versions", async () => {
  const { goalId, planId, deps } = world({ approve: true });
  moveTaskTo(db, byKey(db, goalId, "a").id, "running");
  const lookup = createPlanLookup(deps);
  const seen: string[] = [];
  const handle = createSlashHandler({
    ownerId: "111",
    onMessage: async () => {},
    plan: (t, h) => {
      seen.push(`${t}:${h}`);
      return lookup(t, h);
    },
  });
  const stranger = fakePlan("222");
  await handle(stranger.i);
  expect(seen).toEqual([]);
  expect(stranger.replies[0].flags).toBe(64);
  const owner = fakePlan("111");
  await handle(owner.i);
  const text = owner.replies[0].content as string;
  expect(owner.replies[0].flags).toBe(64);
  expect(text).toContain("Kế hoạch v1 (approved)"); // a bare /plan reads as the default language (vi)
  expect(text).toContain('- a "Do a": running');
  expect(text).toContain("https://v.example/a/");
  // A second version, then the history.
  createPlanHandlerFor(plannerCtxOf(deps, goalId), planId, { add: [item("z")] });
  const hist = fakePlan("111", "history");
  await handle(hist.i);
  const lines = (hist.replies[0].content as string).split("\n");
  expect(lines[0]).toBe("Plan versions:");
  expect(lines.filter((l) => l.startsWith("- v"))).toHaveLength(2);
  expect(lines[2]).toMatch(/^- v1 superseded, \d{4}-\d\d-\d\d \d\d:\d\d/);
  expect(seen).toEqual([`${TH}:false`, `${TH}:true`]);
});

test("/plan text: none, and no link line when the viewer is off", () => {
  expect(renderPlanFacts({ kind: "none" }, "en")).toBe("This thread has no plan yet.");
  const f: PlanFacts = { kind: "current", version: 2, status: "approved", items: [] };
  expect(renderPlanFacts(f, "en")).toBe("Plan v2 (approved)");
});

test("the digest shows the plan version, a revision counts as a change, and the post carries the link", async () => {
  const { goalId, planId, deps, env } = world({ approve: true });
  moveTaskTo(db, byKey(db, goalId, "a").id, "running");
  const f1 = digestFacts(db, goalId, "build it", 1);
  expect(f1.planVersion).toBe(1);
  expect(renderDigest(f1, "en")).toContain("Plan: v1");
  const posts: { text: string; links?: unknown }[] = [];
  const rt = {
    deps: { db, config: { ...env.config, viewer: VIEWER } },
    announce: () => {},
    ctxOf: () => ({
      message: {
        text: "hi",
        language: "en",
        notify: async (text: string, o?: { links?: unknown }) =>
          void posts.push({ text, links: o?.links }),
      },
    }),
  } as unknown as LeadRuntime;
  const tick = createCheckIn();
  await tick(rt, 10_000_000 - DIGEST_FLOOR_MS); // first sight is silent
  await tick(rt, 10_000_000);
  expect(posts).toHaveLength(1);
  expect(posts[0]?.text).toContain("Plan: v1");
  expect((posts[0]?.links as { url: string }[] | undefined)?.[0]?.url).toStartWith(
    "https://v.example/a/",
  );
  // Nothing changed: silent. A revision (new version) is a change.
  const key1 = factsKey(f1);
  await tick(rt, 10_000_000 + 3_600_000);
  expect(posts).toHaveLength(1);
  createPlanHandlerFor(plannerCtxOf(deps, goalId), planId, { add: [item("z")] });
  expect(factsKey(digestFacts(db, goalId, "build it", 1))).not.toBe(key1);
  await tick(rt, 10_000_000 + 7_200_000);
  expect(posts).toHaveLength(2);
  expect(posts[1]?.text).toContain("Plan: v2");
});

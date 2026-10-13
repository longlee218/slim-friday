import { describe, expect, test } from "bun:test";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createJevClient } from "../src/intent/jev/jev-client";
import { createJevProposer } from "../src/intent/jev/jev-proposer";
import { ROLES } from "../src/roles/role-registry";

// PAID live test (TypeSafe System One). Runs only with a real JEV_API_KEY AND JEV_LIVE=1; the owner approves each run.
const key = process.env.JEV_API_KEY;
const live = !!key && key !== PLACEHOLDER && key !== "sk_" && process.env.JEV_LIVE === "1";
if (!live) process.stderr.write("SKIP live-jev smoke: needs a real JEV_API_KEY and JEV_LIVE=1\n");

describe.skipIf(!live)("live Jev smoke (TypeSafe System One)", () => {
  const proposer = () => createJevProposer(createJevClient(key!));
  const base = { threadId: "live", recent: [] };
  const bg = Object.values(ROLES).find((r) => r.background)!;

  // Shapes only (never labels): a proposal kind, a role from the registry, numbers in [0, 1], latency recorded.
  const shape = (p: Awaited<ReturnType<ReturnType<typeof proposer>["propose"]>>) => {
    expect(["pick", "continue", "multi", "undecided"]).toContain(p.kind);
    if (p.kind === "pick") expect(ROLES[p.role]).toBeDefined();
    expect(p.scores?.ms).toBeGreaterThan(0);
    for (const v of Object.values(p.scores?.ranking ?? {})) expect(v).toBeGreaterThanOrEqual(0);
  };

  test("clear code request", async () => {
    shape(await proposer().propose({ ...base, text: "add a unit test for the cart coupon rules" }));
  }, 15_000);

  test("question", async () => {
    shape(
      await proposer().propose({ ...base, text: "how does the session cache expire entries?" }),
    );
  }, 15_000);

  test("follow-up on a waiting task", async () => {
    const p = await proposer().propose({
      ...base,
      text: "yes, go on",
      state: "idle",
      task: { taskId: "t", ownerRole: bg.name, status: "waiting_user", scope: "add coupon tests" },
    });
    shape(p);
    expect(p.scores?.continueP).toBeDefined();
  }, 15_000);
});

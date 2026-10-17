import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELETE_PATHS_TOOL } from "../src/mcp/effects/tools/DeletePathsTool/constants";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { EFFECTS_MCP_SERVER, mcpToolName } from "../src/mcp/mcp-tool-names";
import { DISPATCH_AGENT_TOOL } from "../src/mcp/orchestration/tools/DispatchAgentTool/constants";
import { parseMessageCommand } from "../src/orchestrator/message-commands";
import { addLocation, makeEnv } from "./helpers";
import { leadHarness, until } from "./lead-harness";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(cleanupTmp);

/* End to end with a fake query: plan approved (R2, keep) -> the developer deletes inside the envelope through DeletePaths
   (trash + effect_log, no question) -> outside the envelope the owner is asked once per act (R4: another location) ->
   git push in the shell and GitPush are denied -> /purge empties the thread's trash. */

const GOAL = /Goal id: ([0-9a-f-]{36})/;
const PLAN_ID = /"planId":"([0-9a-f-]{36})"/;
const tool = (name: string) => mcpToolName(EFFECTS_MCP_SERVER, name);

test("plan approved -> DeletePaths in the envelope (trash, no question); outside it one owner question per act; push denied; /purge", async () => {
  const env = makeEnv();
  const other = tmpRoot("friday-other-");
  addLocation(env.home, "other", {}, { path: other });
  const inside = join(env.location, "old.txt");
  writeFileSync(inside, "inside");
  const outsideA = join(other, "a.txt");
  const outsideB = join(other, "b.txt");
  writeFileSync(outsideA, "A");
  writeFileSync(outsideB, "B");

  const confirms: string[] = [];
  let ownerAnswer = true;
  const seen: Record<string, unknown> = {};
  let leadApproved = false;
  const h = leadHarness(
    async (c) => {
      if (c.kind === "planner") {
        const goalId = GOAL.exec(c.prompt)?.[1] as string;
        const made = await c.tool("CreatePlan", {
          goalId,
          items: [
            {
              key: "cleanup",
              role: "developer",
              brief: "remove old.txt",
              location: "location",
              dependsOn: [],
              risk: "R2",
            },
          ],
          acceptanceCriteria: ["old.txt is gone"],
          envelope: {
            locations: ["location"],
            riskClasses: ["R0", "R1", "R2"],
            bounds: { maxItems: 4, maxGb: 1 },
          },
          budgetUsd: 2,
          effects: [],
        });
        await c.tool("ReportResult", {
          title: "T",
          status: "COMPLETED",
          summary: `plan ${made.planId} v1`,
        });
        return "planned";
      }
      if (c.kind === "worker") {
        if (c.prompt.includes("Acceptance criteria:")) {
          // The code-appended verify run: it only reports (the checks below belong to the cleanup item).
          await c.tool("ReportResult", { title: "T", status: "COMPLETED", summary: "verified" });
          return "worker done";
        }
        const can = (t: string, input: object) => c.options.canUseTool(t, input, {});
        // Inside the envelope: the guard lets the call reach the tool, which moves the file to the trash without a question.
        seen.guardIn = (
          await can(tool(DELETE_PATHS_TOOL), { paths: [inside], reason: "r" })
        ).behavior;
        seen.deleteIn = await c.tool(DELETE_PATHS_TOOL, { paths: [inside], reason: "stale file" });
        seen.confirmsAfterIn = confirms.length;
        // Outside the envelope (a location the goal does not use): R4, asked at every act.
        seen.deleteOutA = await c.tool(DELETE_PATHS_TOOL, { paths: [outsideA], reason: "r" });
        ownerAnswer = false;
        seen.deleteOutB = await c.tool(DELETE_PATHS_TOOL, { paths: [outsideB], reason: "r" });
        // The shell is not parsed (the OS sandbox bounds it); an ungranted GitPush tool call is denied.
        seen.bash = (await can("Bash", { command: "git push origin feat/x" })).behavior;
        seen.toolPush = await can(tool(GIT_PUSH_TOOL), {
          location: "location",
          remote: "origin",
          branch: "feat/x",
        });
        await c.tool("ReportResult", { title: "T", status: "COMPLETED", summary: "removed" });
        return "worker done";
      }
      if (c.prompt.includes("Owner message:\ncleanup")) {
        await c.tool("RequestPlan", { objective: "clean up" });
        return "Planning it.";
      }
      const plan = PLAN_ID.exec(c.prompt)?.[1];
      if (plan && !leadApproved) {
        leadApproved = true;
        await c.tool("ApprovePlan", { planId: plan, version: 1 });
        return "Plan approved.";
      }
      return c.prompt.includes('"key":"cleanup"') ? "Cleanup done." : "";
    },
    env,
    {
      askChoice: async () => "Approve plan",
      confirm: async (req) => {
        confirms.push(req.summary);
        return { approved: ownerAnswer };
      },
    },
  );
  await h.send("cleanup");
  await until(() => h.posts.includes("Cleanup done."), 12000);

  // Inside: moved, one audit row granted by the plan, no question yet.
  expect(seen.guardIn).toBe("allow");
  expect(seen.deleteIn).toMatchObject({ ok: true, moved: 1 });
  expect(seen.confirmsAfterIn).toBe(0);
  expect(existsSync(inside)).toBe(false);
  const rows = h.env.db
    .query(
      "SELECT tool, granted_by AS by, undo FROM effect_log WHERE tool = ? AND undo IS NOT NULL",
    )
    .all(DELETE_PATHS_TOOL) as { by: string; undo: string }[];
  expect(rows).toHaveLength(2); // moves only: the denied third call left a refusal row without an undo
  expect(rows[0]?.by).toMatch(/^plan:[0-9a-f-]{36}@v1$/);
  expect(rows[1]?.by).toBe("owner");
  const moved = (JSON.parse(rows[0]?.undo ?? "{}") as { restore: { from: string; to: string }[] })
    .restore[0];
  expect(moved?.from).toBe(`${realpathSync(env.location)}/old.txt`);
  expect(readFileSync(moved?.to ?? "", "utf8")).toBe("inside");
  // Outside: asked once per act (yes moved it, no kept it).
  expect(confirms).toHaveLength(2);
  expect(seen.deleteOutA).toMatchObject({ ok: true });
  expect(seen.deleteOutB).toMatchObject({ ok: false, code: "OWNER_DENIED" });
  expect(existsSync(outsideA)).toBe(false);
  expect(existsSync(outsideB)).toBe(true);
  // Push: the shell call passes the guard (the sandbox has no network); the tool outside the envelope is denied.
  expect(seen.bash).toBe("allow");
  expect(seen.toolPush).toMatchObject({ behavior: "deny" });
  expect((seen.toolPush as { message: string }).message).toContain("OUT_OF_ENVELOPE");
  // /purge: this thread's trash is emptied now.
  const trash = join(env.home, "trash");
  expect(readdirSync(trash)).toHaveLength(1);
  // Final, so it asks one click first (the plain word `purge` too): a no keeps the trash, a yes empties it.
  ownerAnswer = false;
  expect(await h.send("/purge")).toContain("Cancelled");
  expect(readdirSync(trash)).toHaveLength(1);
  expect(confirms.at(-1)).toContain("Empty the trash");
  ownerAnswer = true;
  expect(await h.send("/purge")).toContain("Emptied the trash of 1 goal");
  expect(existsSync(moved?.to ?? "")).toBe(false);
  expect(await h.send("/purge")).toContain("empty");
});

test("the dispatch lists effect grants: one owner question, No = nothing starts, Yes = the grant is stored for the workers", async () => {
  const answers = ["No", "Yes"];
  const questions: string[] = [];
  const h = leadHarness(
    async (c) => {
      if (c.kind === "worker") return "worker done";
      if (c.prompt.includes("Owner message:\nship it")) {
        const call = {
          strategy: "DIRECT",
          intent: "ship",
          reason: "owner asked for a PR",
          assignments: [
            {
              key: "main",
              role: "developer",
              brief: "open a PR",
              location: "location",
              dependsOn: [],
            },
          ],
          effects: [{ tool: GIT_PUSH_TOOL, location: "location", branch: "feat/x" }],
        };
        const first = await c.tool(DISPATCH_AGENT_TOOL, call);
        expect(first).toMatchObject({ ok: false, code: "OWNER_DENIED" });
        expect(
          await c.tool(DISPATCH_AGENT_TOOL, { ...call, reason: "owner agreed" }),
        ).toMatchObject({ ok: true });
        return "Started.";
      }
      return "";
    },
    makeEnv(),
    {
      askChoice: async (a) => {
        questions.push(a.question);
        return answers.shift();
      },
    },
  );
  await h.send("ship it");
  await until(() => h.posts.includes("Started."), 4000);
  expect(questions).toHaveLength(2);
  expect(questions[0]).toContain("GitPush on location (branch feat/x)");
  const grant = h.env.db
    .query("SELECT scope, granted_by AS by FROM effect_log WHERE id LIKE 'grant:%'")
    .all();
  expect(grant).toHaveLength(1); // only the accepted dispatch stored its grant
  expect(JSON.parse((grant[0] as { scope: string }).scope)).toEqual([
    { tool: GIT_PUSH_TOOL, scope: { location: "location", branch: "feat/x" } },
  ]);
  expect(
    h.env.db.query("SELECT COUNT(*) AS n FROM owned_tasks WHERE parent_id IS NULL").get(),
  ).toEqual({ n: 1 });
});

test("/purge is a command of its own", () => {
  expect(parseMessageCommand("/purge")).toEqual({ kind: "purge" });
  expect(parseMessageCommand("purge")).toEqual({ kind: "message" });
  expect(parseMessageCommand("/purge everything").kind).toBe("message");
});

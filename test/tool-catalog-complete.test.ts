import { expect, test } from "bun:test";
import { EXTERNAL_SERVERS } from "../src/mcp/manifests";
import { buildServers } from "../src/mcp/mcp-servers";
import { EFFECTS_MCP_SERVER, mcpToolName } from "../src/mcp/mcp-tool-names";
import { classifyToolCall } from "../src/policy/classify-tool-call";
import { getRole } from "../src/roles/role-registry";
import { CAPABILITY_TOOLS } from "../src/tools/capability-tools";
import { validateForKind, validateToolIds } from "../src/tools/derive-tool-policy";
import { TOOL_BY_ID, TOOL_CATALOG } from "../src/tools/tool-catalog-entries";
import { ALL_TOOL_NAMES, FULL_CTX, toolsByServer } from "./mcp-ctx-fixture";

/* The catalog lists every tool exactly once, and what it says about a tool matches what the engine builds and classifies. */

const EXTERNAL_TOOLS = EXTERNAL_SERVERS.flatMap((s) => s.tools);
const BUILT_FOR_ANY_RUN = ["MemorySave", "MemoryEdit", "SaveArtifact"];
const EFFECT_TOOLS = ["DeletePaths", "MergeBranch", "GitPush", "CreatePullRequest"];

test("every capability group and every MCP tool has exactly one catalog entry", () => {
  const ids = TOOL_CATALOG.map((d) => d.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const g of Object.keys(CAPABILITY_TOOLS)) expect([g, TOOL_BY_ID.has(g)]).toEqual([g, true]);
  for (const t of [...ALL_TOOL_NAMES, ...EXTERNAL_TOOLS])
    expect([t, TOOL_BY_ID.has(t)]).toEqual([t, true]);
});

test("catalog risk equals classifyToolCall; R2 or higher only for the effect tools", () => {
  for (const d of TOOL_CATALOG) {
    if (d.risk >= "R2") expect([d.id, EFFECT_TOOLS.includes(d.id)]).toEqual([d.id, true]);
  }
  for (const t of EFFECT_TOOLS) {
    const d = TOOL_BY_ID.get(t);
    expect(classifyToolCall(mcpToolName(EFFECTS_MCP_SERVER, t))).toBe(d?.risk as never);
  }
});

test("runKinds match what a worker ctx and a teammate ctx build", () => {
  const all = { ...getRole("developer"), mcpTools: ALL_TOOL_NAMES };
  const workerCtx = { ...FULL_CTX, teammate: undefined, admin: undefined };
  const teammateCtx = {
    ...FULL_CTX,
    reportSink: undefined,
    progress: undefined,
    message: undefined,
    admin: undefined,
  };
  const built = (ctx: typeof FULL_CTX) =>
    new Set(Object.values(toolsByServer(buildServers(all as never, ctx))).flat());
  const w = built(workerCtx);
  const t = built(teammateCtx);
  const wrong: string[] = [];
  for (const name of ALL_TOOL_NAMES) {
    const d = TOOL_BY_ID.get(name);
    if (!d || d.runKinds.includes("control")) continue;
    // Built from the memory / artifacts ctx that every run has: the catalog (and the guard) keep them off workers.
    if (!BUILT_FOR_ANY_RUN.includes(name) && w.has(name) !== d.runKinds.includes("worker"))
      wrong.push(`${name}: worker`);
    if (t.has(name) !== d.runKinds.includes("teammate")) wrong.push(`${name}: teammate`);
  }
  expect(wrong).toEqual([]);
});

test("validateForKind refuses a tool the kind cannot build; validateToolIds refuses an unknown id", () => {
  expect(() => validateForKind(["Report"], "teammate")).toThrow("Report");
  expect(() => validateToolIds(["NoSuchTool"])).toThrow("NoSuchTool");
});

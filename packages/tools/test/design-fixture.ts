import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignContext } from "../src/design/design-context";
import { FileMemory } from "../src/memory/file-memory";

type Result = { content: { text: string }[]; isError?: boolean };

/** Call a tool handler the way the SDK would. */
export const call = (
  t: { handler: (a: never, e: unknown) => Promise<unknown> },
  args: object,
): Promise<Result> => t.handler(args as never, {}) as Promise<Result>;

/** Text of a result. */
export const textOf = (r: Result): string => r.content.map((c) => c.text).join("\n");

/** A skill file the tests can write: `<dir>/<name>/SKILL.md`. */
export function putSkill(dir: string, name: string, description = "Does a thing well enough.") {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
  );
}

/** A home with config dirs, a scratch dir, a shipped skills dir and a context wired to fakes. */
export function setup(over: Partial<DesignContext> = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "design-")));
  const home = join(base, "home");
  const configDir = join(home, "config");
  const scratchDir = join(home, "scratch", "friday");
  const shippedSkills = join(base, "shipped-skills");
  const shippedBots = join(base, "shipped-bots");
  for (const d of ["bots", "groups", "skills"]) mkdirSync(join(configDir, d), { recursive: true });
  for (const d of [scratchDir, shippedSkills, shippedBots]) mkdirSync(d, { recursive: true });
  putSkill(shippedSkills, "shipped-one");
  writeFileSync(join(shippedBots, "friday.md"), "---\nname: Friday\n---\nShipped.\n");
  const ctx: DesignContext = {
    botId: "friday",
    agentHome: home,
    configDir,
    scratchDir,
    botDirs: [join(configDir, "bots"), shippedBots],
    skillDirs: [join(configDir, "skills"), shippedSkills],
    reservedBotIds: ["friday"],
    catalogTools: () => ["Read", "Grep", "Bash", "Agent", "mcp__effects__GitPush"],
    mcpNames: () => ["playwright"],
    botSummaries: () => [{ id: "friday", name: "Friday", title: "team builder" }],
    groupSummaries: () => [],
    presetAvatars: () => ["fox"],
    readBotFile: () => undefined,
    nameTaken: () => false,
    // A stand-in for the real parsers: the text must at least carry a name line.
    checkBot: (_id, text) => {
      if (!text.includes("name:")) throw new Error("no name");
    },
    checkGroup: (_id, text) => {
      if (!text.includes("members:")) throw new Error("no members");
    },
    checkMcp: (text) => {
      if (!text.includes("servers:")) throw new Error("no servers");
    },
    envDenied: (n) =>
      /^(CLAUDE_CODE_|ANTHROPIC_|R2_|AGENT_HOME|FIRECRAWL_API_KEY|GITHUB_PERSONAL_ACCESS_TOKEN)/.test(
        n,
      ),
    gitHead: async () => "abc123",
    memory: new FileMemory(join(home, "memory")),
    insight: {
      runStats: async () => [],
      turns: async () => [],
      activity: async () => [],
    },
    messages: { get: async () => undefined, page: async () => [] },
    now: () => Date.now(),
    ...over,
  };
  return { base, home, configDir, scratchDir, shippedSkills, ctx };
}

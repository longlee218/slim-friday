import {
  AdminError,
  type AvatarTarget,
  type BotEntry,
  type BotInput,
  type ConfigAdmin,
  type GroupEntry,
  type GroupInput,
  type McpEntry,
  type McpProbe,
  type McpServerInput,
  type MemoryAdmin,
  type OwnerFile,
  type SkillAdmin,
  type SkillEntry,
} from "@friday/core";

/** Every call the fakes received, as `[method, ...args]`, so tests can assert "never called". */
export type CallLog = unknown[][];

/** In-memory `ConfigAdmin`; `failWith` makes the next call throw that error once. */
export class FakeConfigAdmin implements ConfigAdmin {
  bots = new Map<string, BotEntry>();
  groups = new Map<string, GroupEntry>();
  mcp = new Map<string, McpEntry>();
  owner: Record<OwnerFile, string> = { USER: "", SOUL: "" };
  calls: CallLog = [];
  failWith?: AdminError;
  private fail(name: string, args: unknown[]) {
    this.calls.push([name, ...args]);
    if (this.failWith) {
      const e = this.failWith;
      this.failWith = undefined;
      throw e;
    }
  }
  listBots = () => [...this.bots.values()];
  getBot(id: string) {
    this.fail("getBot", [id]);
    const b = this.bots.get(id);
    if (!b) throw new AdminError("NOT_FOUND", `no bot ${id}`);
    return b;
  }
  saveBot(b: BotInput, mode: "create" | "update") {
    this.fail("saveBot", [b, mode]);
    this.bots.set(b.id, { ...b, shipped: false });
  }
  deleteBot(id: string) {
    this.fail("deleteBot", [id]);
    this.bots.delete(id);
  }
  listGroups = () => [...this.groups.values()];
  getGroup(id: string) {
    this.fail("getGroup", [id]);
    const g = this.groups.get(id);
    if (!g) throw new AdminError("NOT_FOUND", `no group ${id}`);
    return g;
  }
  saveGroup(g: GroupInput, mode: "create" | "update") {
    this.fail("saveGroup", [g, mode]);
    this.groups.set(g.id, g);
  }
  deleteGroup(id: string) {
    this.fail("deleteGroup", [id]);
    this.groups.delete(id);
  }
  setAvatar(_t: AvatarTarget, _a: string | null) {
    return {};
  }
  presets = () => [];
  readOwnerFile(f: OwnerFile) {
    this.fail("readOwnerFile", [f]);
    return this.owner[f];
  }
  saveOwnerFile(f: OwnerFile, text: string) {
    this.fail("saveOwnerFile", [f, text]);
    this.owner[f] = text;
  }
  listMcp = () => [...this.mcp.values()];
  saveMcp(name: string, s: McpServerInput, mode: "create" | "update") {
    this.fail("saveMcp", [name, s, mode]);
    this.mcp.set(name, { name, server: s, shipped: false, usedBy: [] });
  }
  deleteMcp(name: string) {
    this.fail("deleteMcp", [name]);
    this.mcp.delete(name);
  }
  checkMcpServer(name: string, s: McpServerInput) {
    this.fail("checkMcpServer", [name, s]);
  }
}

/** A skill entry with defaults. */
export const skill = (name: string, over: Partial<SkillEntry> = {}): SkillEntry => ({
  name,
  description: "d",
  shipped: false,
  files: [],
  body: "",
  usedBy: [],
  ...over,
});

/** In-memory `SkillAdmin`; `failWith` makes the next call throw once. */
export class FakeSkillAdmin implements SkillAdmin {
  skills = new Map<string, SkillEntry>();
  calls: CallLog = [];
  failWith?: AdminError;
  private fail(name: string, args: unknown[]) {
    this.calls.push([name, ...args]);
    if (this.failWith) {
      const e = this.failWith;
      this.failWith = undefined;
      throw e;
    }
  }
  list = () => [...this.skills.values()];
  async lookup(source: string, path?: string) {
    this.fail("lookup", [source, path]);
    return { lookupId: "l1", source, sha: "abc", expiresAt: 9, skills: [] };
  }
  install(lookupId: string, name: string) {
    this.fail("install", [lookupId, name]);
    const s = skill(name, { installedAt: "2026-10-24T00:00:00.000Z" });
    this.skills.set(name, s);
    return s;
  }
  async checkUpdate(name: string) {
    this.fail("checkUpdate", [name]);
    return { latestSha: "b", updateAvailable: true };
  }
  update(lookupId: string, name: string) {
    this.fail("update", [lookupId, name]);
    return skill(name);
  }
  remove(name: string) {
    this.fail("remove", [name]);
    this.skills.delete(name);
    return { botIds: ["a"] };
  }
  setUsedBy(name: string, botIds: string[]) {
    this.fail("setUsedBy", [name, botIds]);
    return skill(name, { usedBy: botIds });
  }
}

/** The four settings deps over fakes; the probe returns `probeResult` and records its calls. */
export function fakeSettings() {
  const config = new FakeConfigAdmin();
  const skills = new FakeSkillAdmin();
  const probeCalls: CallLog = [];
  const state: { probeResult: Awaited<ReturnType<McpProbe>> } = {
    probeResult: { status: "connected", tools: [] },
  };
  const probe: McpProbe = async (name, server) => {
    probeCalls.push([name, server]);
    return state.probeResult;
  };
  return {
    config,
    skills,
    probe,
    probeCalls,
    state,
    // Memory routes are a later task; nothing here calls them.
    memory: {} as MemoryAdmin,
  };
}

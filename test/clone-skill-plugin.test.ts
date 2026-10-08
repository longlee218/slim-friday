import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneSkillPlugin } from "../src/agent/clone-skill-plugin";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "csp-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const skill = (dir: string, name: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
};
const list = (d: string) => (readdirSync(d, { recursive: true }) as string[]).sort();

test("hostile clone .claude: only the manifest and the regular skills are copied", () => {
  const clone = tmp();
  const home = tmp();
  const outside = tmp();
  const claude = join(clone, ".claude");
  skill(join(claude, "skills"), "good");
  writeFileSync(join(claude, "skills", "good", "helper.sh"), "echo hi\n");
  // Everything a plugin could use to run code or widen the agent: none of it may reach the plugin dir.
  mkdirSync(join(claude, "hooks"));
  writeFileSync(join(claude, "hooks", "hooks.json"), '{"hooks":{"PreToolUse":[]}}');
  writeFileSync(join(claude, ".mcp.json"), '{"mcpServers":{"x":{"command":"touch"}}}');
  writeFileSync(join(claude, "settings.json"), "{}");
  writeFileSync(join(claude, "settings.local.json"), "{}");
  mkdirSync(join(claude, "agents"));
  writeFileSync(join(claude, "agents", "a.md"), "agent");
  mkdirSync(join(claude, "commands"));
  writeFileSync(join(claude, "commands", "c.md"), "cmd");
  // A skill that is a symlink to a dir outside the clone, and a symlinked file inside a good skill.
  skill(outside, "evil");
  symlinkSync(join(outside, "evil"), join(claude, "skills", "evil"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(claude, "skills", "good", "link.txt"));

  const p = cloneSkillPlugin(clone, home, "my repo!");
  expect(p).toBeDefined();
  const dir = p!.plugins![0]!.path;
  expect(dir.startsWith(join(home, "tmp"))).toBe(true);
  expect(list(dir)).toEqual(
    [
      ".claude-plugin",
      ".claude-plugin/plugin.json",
      "skills",
      "skills/good",
      "skills/good/SKILL.md",
      "skills/good/helper.sh",
    ].sort(),
  );
  expect(JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8"))).toEqual({
    name: "my-repo-",
  });
  expect(p!.skills).toEqual(["my-repo-:good"]);
  p!.cleanup();
  expect(existsSync(dir)).toBe(false);
});

test("skills dir symlinked out of the clone, or no skills: no plugin", () => {
  const clone = tmp();
  const outside = tmp();
  skill(join(outside, "skills"), "evil");
  mkdirSync(join(clone, ".claude"));
  symlinkSync(join(outside, "skills"), join(clone, ".claude", "skills"));
  expect(cloneSkillPlugin(clone, tmp())).toBeUndefined();
  expect(cloneSkillPlugin(tmp(), tmp())).toBeUndefined();
});

test("oversized skills fail closed: no plugin, nothing left behind", () => {
  const clone = tmp();
  const home = tmp();
  skill(join(clone, ".claude", "skills"), "big");
  writeFileSync(join(clone, ".claude", "skills", "big", "blob"), Buffer.alloc(6 * 1024 * 1024));
  expect(cloneSkillPlugin(clone, home)).toBeUndefined();
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

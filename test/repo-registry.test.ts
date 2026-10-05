import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isManagedClone } from "../src/repos/refresh-repo";
import { buildRegistryContext, loadRepoRegistry, parseRepoPin } from "../src/repos/repo-registry";
import { getSession } from "../src/storage/session-store";
import { createTaskHandler } from "../src/tasks/handle-task";
import { makeEnv, resultMsg } from "./helpers";

/** Create a fake git repo dir (a `.git` dir is all the validator checks). */
function fakeRepo(root: string, name: string): string {
  const p = join(root, name);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
}

test("loads valid entries; skips missing path, non-git dir, duplicate and bad shape", () => {
  const env = makeEnv();
  const a = fakeRepo(env.home, "a");
  const b = fakeRepo(env.home, "b");
  mkdirSync(join(env.home, "plain"));
  writeFileSync(
    join(env.home, "repos.yaml"),
    [
      `- {name: a, path: ${a}, description: api}`,
      `- {name: b, path: ${b}}`,
      `- {name: gone, path: ${join(env.home, "nope")}}`,
      `- {name: plain, path: ${join(env.home, "plain")}}`,
      `- {name: a, path: ${b}}`,
      `- {path: ${a}}`,
    ].join("\n"),
  );
  const repos = loadRepoRegistry(env.home);
  expect(repos.map((r) => r.name)).toEqual(["a", "b"]);
  expect(repos[0]!.description).toBe("api");
});

test("returns empty when repos.yaml is absent, not a list, or has no valid entry", () => {
  const env = makeEnv();
  rmSync(join(env.home, "repos.yaml"));
  expect(loadRepoRegistry(env.home)).toEqual([]);
  writeFileSync(join(env.home, "repos.yaml"), "not: a list");
  expect(loadRepoRegistry(env.home)).toEqual([]);
});

test("handler tells the owner to add a repo when none is registered", async () => {
  const env = makeEnv();
  rmSync(join(env.home, "repos.yaml"));
  const handle = createTaskHandler({ db: env.db, config: env.config });
  const reply = await handle({ source: "t", userId: "u", threadId: "t1", text: "hi" });
  expect(reply).toContain("No repos registered");
});

test("parseRepoPin splits prefix; registry block only for 2+ repos", () => {
  expect(parseRepoPin("repo:api how does auth work?")).toEqual({
    name: "api",
    text: "how does auth work?",
  });
  expect(parseRepoPin("plain question")).toEqual({ text: "plain question" });
  const one = [{ name: "a", path: "/a", description: "" }];
  expect(buildRegistryContext(one)).toBe("");
  expect(buildRegistryContext([...one, { name: "b", path: "/b", description: "web" }])).toContain(
    "- b: /b — web",
  );
});

test("handler: unpinned uses all repos; pin sticks to thread; unknown pin rejected", async () => {
  const env = makeEnv();
  const a = fakeRepo(env.home, "a");
  const b = fakeRepo(env.home, "b");
  writeFileSync(join(env.home, "repos.yaml"), `- {name: a, path: ${a}}\n- {name: b, path: ${b}}`);
  const seen: any[] = [];
  const queryFn = (args: any) => {
    seen.push(args);
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTaskHandler({ db: env.db, config: env.config, queryFn: queryFn as never });
  const t = (threadId: string, text: string) => ({ source: "t", userId: "u", threadId, text });

  await handle(t("t1", "where is x?"));
  expect(seen[0].options.cwd).toBe(a);
  expect(seen[0].options.additionalDirectories).toEqual([b]);
  expect(seen[0].options.systemPrompt.append).toContain("Available repos");

  await handle(t("t2", "repo:b where is y?"));
  expect(seen[1].prompt).toBe("where is y?");
  expect(seen[1].options.cwd).toBe(b);
  expect(seen[1].options.additionalDirectories).toBeUndefined();
  expect(getSession(env.db, "t2")?.repo).toBe("b");

  await handle(t("t2", "follow up")); // no prefix: stays on b
  expect(seen[2].options.cwd).toBe(b);

  expect(await handle(t("t3", "repo:zzz hi"))).toContain("Unknown repo");
  expect(await handle(t("t3", "repo:a"))).toContain("Send your question");
  expect(seen).toHaveLength(3);
});

test("re-pinning to another repo starts a fresh session (no resume across cwd)", async () => {
  const env = makeEnv();
  const a = fakeRepo(env.home, "a");
  const b = fakeRepo(env.home, "b");
  writeFileSync(join(env.home, "repos.yaml"), `- {name: a, path: ${a}}\n- {name: b, path: ${b}}`);
  const seen: any[] = [];
  const queryFn = (args: any) => {
    seen.push(args);
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTaskHandler({ db: env.db, config: env.config, queryFn: queryFn as never });
  const t = (text: string) => ({ source: "t", userId: "u", threadId: "t1", text });
  await handle(t("repo:a first"));
  await handle(t("same repo follow up"));
  await handle(t("repo:b switch"));
  expect(seen[0].options.resume).toBeUndefined();
  expect(seen[1].options.resume).toBe("sess-1");
  expect(seen[2].options.resume).toBeUndefined();
});

test("isManagedClone rejects paths outside AGENT_HOME/repos, including .. and symlinks", () => {
  const env = makeEnv();
  const inside = fakeRepo(join(env.home, "repos"), "x");
  const outside = fakeRepo(env.home, "dev");
  symlinkSync(outside, join(env.home, "repos", "link"));
  expect(isManagedClone(inside, env.home)).toBe(true);
  expect(isManagedClone(join(env.home, "repos", "..", "dev"), env.home)).toBe(false);
  expect(isManagedClone(join(env.home, "repos", "link"), env.home)).toBe(false);
  expect(isManagedClone("/nonexistent", env.home)).toBe(false);
});

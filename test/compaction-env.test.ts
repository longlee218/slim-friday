import { afterEach, describe, expect, test } from "bun:test";
import { resolveCompactWindow } from "../src/config/model-routing";
import { QA_AUTO_COMPACT_WINDOW } from "../src/roles/builtin/assistant-role";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { AUTO_COMPACT_WINDOW_VAR, sdkEnv } from "../src/runtime/sdk-env";
import { initMsg, makeEnv, resultMsg } from "./helpers";

/** Options the fake query saw for one run of `role`. */
async function optionsOf(env: ReturnType<typeof makeEnv>, role: string) {
  let seen: any;
  await runAgent({
    prompt: "p",
    turnId: "T",
    role: getRole(role),
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: ((a: any) => {
      seen = a.options;
      return (async function* () {
        yield initMsg;
        yield resultMsg();
      })();
    }) as never,
  });
  return seen;
}

const saved = process.env[AUTO_COMPACT_WINDOW_VAR];
afterEach(() => {
  if (saved === undefined) delete process.env[AUTO_COMPACT_WINDOW_VAR];
  else process.env[AUTO_COMPACT_WINDOW_VAR] = saved;
});

describe("compaction env (set by the app per role, never inherited)", () => {
  test("sdkEnv: the var comes only from the stage value, never from the caller env", () => {
    const { config } = makeEnv();
    const shell = { PATH: "/bin", [AUTO_COMPACT_WINDOW_VAR]: "50000" };
    expect(sdkEnv(config, shell)[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
    expect(sdkEnv(config, shell, 150_000)[AUTO_COMPACT_WINDOW_VAR]).toBe("150000");
  });

  test("assistant: present with the conservative default; dev: absent", async () => {
    const env = makeEnv();
    expect((await optionsOf(env, "assistant")).env[AUTO_COMPACT_WINDOW_VAR]).toBe(
      String(QA_AUTO_COMPACT_WINDOW),
    );
    expect((await optionsOf(env, "dev")).env[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
  });

  test("the owner's shell value reaches neither stage", async () => {
    process.env[AUTO_COMPACT_WINDOW_VAR] = "12345";
    const env = makeEnv();
    expect((await optionsOf(env, "dev")).env[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
    expect((await optionsOf(env, "assistant")).env[AUTO_COMPACT_WINDOW_VAR]).toBe(
      String(QA_AUTO_COMPACT_WINDOW),
    );
  });

  test("COMPACT_WINDOW_<ROLE> overrides; 0 turns it off; garbage fails startup naming the variable", async () => {
    const role = getRole("assistant");
    const set = makeEnv({ COMPACT_WINDOW_ASSISTANT: "150000" });
    expect(resolveCompactWindow(role, set.config)).toBe(150_000);
    expect((await optionsOf(set, "assistant")).env[AUTO_COMPACT_WINDOW_VAR]).toBe("150000");
    const off = makeEnv({ COMPACT_WINDOW_ASSISTANT: "0" });
    expect((await optionsOf(off, "assistant")).env[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
    expect(() => makeEnv({ COMPACT_WINDOW_ASSISTANT: "lots" })).toThrow("COMPACT_WINDOW_ASSISTANT");
  });

  test("range: 0 or 100000-1000000 only; anything else fails startup naming the variable, not the value", () => {
    for (const ok of ["0", "100000", "1000000"])
      expect(() => makeEnv({ COMPACT_WINDOW_ASSISTANT: ok })).not.toThrow();
    for (const bad of ["5", "99999", "1000001", "1e3", "-1", "150000.5"]) {
      let msg = "";
      try {
        makeEnv({ COMPACT_WINDOW_ASSISTANT: bad });
      } catch (e) {
        msg = String(e);
      }
      expect(msg).toContain("COMPACT_WINDOW_ASSISTANT");
      expect(msg).not.toContain(bad);
    }
  });
});

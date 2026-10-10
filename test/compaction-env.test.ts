import { afterEach, describe, expect, test } from "bun:test";
import { resolveCompactWindow } from "../src/config/model-routing";
import { QA_AUTO_COMPACT_WINDOW } from "../src/roles/builtin/assistant-role";
import { getRole, getStage } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { AUTO_COMPACT_WINDOW_VAR, sdkEnv } from "../src/runtime/sdk-env";
import { initMsg, makeEnv, resultMsg } from "./helpers";

/** Options the fake query saw for one run of `stage`. */
async function optionsOf(env: ReturnType<typeof makeEnv>, role: string, stage: string) {
  let seen: any;
  await runAgent({
    prompt: "p",
    taskId: "T",
    stage: getStage(role, stage),
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

describe("compaction env (set by the app per stage, never inherited)", () => {
  test("sdkEnv: the var comes only from the stage value, never from the caller env", () => {
    const { config } = makeEnv();
    const shell = { PATH: "/bin", [AUTO_COMPACT_WINDOW_VAR]: "50000" };
    expect(sdkEnv(config, shell)[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
    expect(sdkEnv(config, shell, 150_000)[AUTO_COMPACT_WINDOW_VAR]).toBe("150000");
  });

  test("qa stage: present with the conservative default; exec stage: absent", async () => {
    const env = makeEnv();
    expect((await optionsOf(env, "assistant", "qa")).env[AUTO_COMPACT_WINDOW_VAR]).toBe(
      String(QA_AUTO_COMPACT_WINDOW),
    );
    expect((await optionsOf(env, "dev", "exec")).env[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
    expect((await optionsOf(env, "dev", "plan")).env[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
  });

  test("the owner's shell value reaches neither stage", async () => {
    process.env[AUTO_COMPACT_WINDOW_VAR] = "12345";
    const env = makeEnv();
    expect((await optionsOf(env, "dev", "exec")).env[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
    expect((await optionsOf(env, "assistant", "qa")).env[AUTO_COMPACT_WINDOW_VAR]).toBe(
      String(QA_AUTO_COMPACT_WINDOW),
    );
  });

  test("COMPACT_WINDOW_<ROLE>_<STAGE> overrides; 0 turns it off; garbage fails startup naming the variable", async () => {
    const qa = getStage("assistant", "qa");
    const role = getRole("assistant");
    const set = makeEnv({ COMPACT_WINDOW_ASSISTANT_QA: "150000" });
    expect(resolveCompactWindow(qa, role, set.config)).toBe(150_000);
    expect((await optionsOf(set, "assistant", "qa")).env[AUTO_COMPACT_WINDOW_VAR]).toBe("150000");
    const off = makeEnv({ COMPACT_WINDOW_ASSISTANT_QA: "0" });
    expect((await optionsOf(off, "assistant", "qa")).env[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
    expect(() => makeEnv({ COMPACT_WINDOW_ASSISTANT_QA: "lots" })).toThrow(
      "COMPACT_WINDOW_ASSISTANT_QA",
    );
  });

  test("range: 0 or 100000-1000000 only; anything else fails startup naming the variable, not the value", () => {
    for (const ok of ["0", "100000", "1000000"])
      expect(() => makeEnv({ COMPACT_WINDOW_ASSISTANT_QA: ok })).not.toThrow();
    for (const bad of ["5", "99999", "1000001", "1e3", "-1", "150000.5"]) {
      let msg = "";
      try {
        makeEnv({ COMPACT_WINDOW_ASSISTANT_QA: bad });
      } catch (e) {
        msg = String(e);
      }
      expect(msg).toContain("COMPACT_WINDOW_ASSISTANT_QA");
      expect(msg).not.toContain(bad);
    }
  });
});

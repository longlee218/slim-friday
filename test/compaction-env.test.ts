import { afterEach, describe, expect, test } from "bun:test";
import { resolveCompactWindow } from "../src/config/model-routing";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import {
  AUTO_COMPACT_WINDOW_VAR,
  AUTOCOMPACT_PCT_VAR,
  COMPACT_PCT,
  COMPACT_WINDOW_TOKENS,
  MAIN_CACHE_TTL,
  PROMPT_CACHE_TTL_VAR,
  SUBAGENT_CACHE_TTL,
  SUBAGENT_CACHE_TTL_VAR,
  sdkEnv,
} from "../src/runtime/sdk-env";
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

const VARS = [
  AUTO_COMPACT_WINDOW_VAR,
  AUTOCOMPACT_PCT_VAR,
  PROMPT_CACHE_TTL_VAR,
  SUBAGENT_CACHE_TTL_VAR,
];
const saved = VARS.map((v) => process.env[v]);
afterEach(() => {
  VARS.forEach((v, i) => {
    if (saved[i] === undefined) delete process.env[v];
    else process.env[v] = saved[i];
  });
});

describe("compaction + cache TTL env (set by the app for every role, never inherited)", () => {
  test("sdkEnv: window falls back to the app default; an explicit value wins; 0 drops only the window var", () => {
    const { config } = makeEnv();
    expect(sdkEnv(config, { PATH: "/bin" })[AUTO_COMPACT_WINDOW_VAR]).toBe(
      String(COMPACT_WINDOW_TOKENS),
    );
    expect(sdkEnv(config, {}, 150_000)[AUTO_COMPACT_WINDOW_VAR]).toBe("150000");
    const off = sdkEnv(config, {}, 0);
    expect(off[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
    expect(off[AUTOCOMPACT_PCT_VAR]).toBe(String(COMPACT_PCT));
  });

  test("sdkEnv oneShot: none of the 4 vars, even with a window given", () => {
    const { config } = makeEnv();
    const e = sdkEnv(config, { PATH: "/bin", [PROMPT_CACHE_TTL_VAR]: "5m" }, 150_000, {
      oneShot: true,
    });
    for (const v of VARS) expect(e[v]).toBeUndefined();
    expect(e.PATH).toBe("/bin");
  });

  test("every role run: window, 75%, main and subagent cache TTL", async () => {
    const env = makeEnv();
    for (const role of ["lead", "developer"]) {
      const e = (await optionsOf(env, role)).env;
      expect(e[AUTO_COMPACT_WINDOW_VAR]).toBe(String(COMPACT_WINDOW_TOKENS));
      expect(e[AUTOCOMPACT_PCT_VAR]).toBe("75");
      expect(e[PROMPT_CACHE_TTL_VAR]).toBe(MAIN_CACHE_TTL);
      expect(e[SUBAGENT_CACHE_TTL_VAR]).toBe(SUBAGENT_CACHE_TTL);
    }
  });

  test("the owner's shell values of the 4 vars reach no role", async () => {
    for (const v of VARS) process.env[v] = "12345";
    const env = makeEnv();
    for (const role of ["lead", "developer"]) {
      const e = (await optionsOf(env, role)).env;
      expect(e[AUTO_COMPACT_WINDOW_VAR]).toBe(String(COMPACT_WINDOW_TOKENS));
      expect(e[AUTOCOMPACT_PCT_VAR]).toBe("75");
      expect(e[PROMPT_CACHE_TTL_VAR]).toBe(MAIN_CACHE_TTL);
      expect(e[SUBAGENT_CACHE_TTL_VAR]).toBe(SUBAGENT_CACHE_TTL);
    }
  });

  test("the window is role data or the app default; no env var changes it", async () => {
    for (const name of ["lead", "developer", "scout", "planner", "discord-manager"] as const) {
      expect(resolveCompactWindow(getRole(name))).toBe(
        getRole(name).autoCompactWindow ?? COMPACT_WINDOW_TOKENS,
      );
    }
    process.env.COMPACT_WINDOW_LEAD = "150000";
    const e = (await optionsOf(makeEnv(), "lead")).env;
    delete process.env.COMPACT_WINDOW_LEAD;
    expect(e[AUTO_COMPACT_WINDOW_VAR]).toBe(String(COMPACT_WINDOW_TOKENS));
  });
});

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
    for (const role of ["lead", "dev"]) {
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
    for (const role of ["lead", "dev"]) {
      const e = (await optionsOf(env, role)).env;
      expect(e[AUTO_COMPACT_WINDOW_VAR]).toBe(String(COMPACT_WINDOW_TOKENS));
      expect(e[AUTOCOMPACT_PCT_VAR]).toBe("75");
      expect(e[PROMPT_CACHE_TTL_VAR]).toBe(MAIN_CACHE_TTL);
      expect(e[SUBAGENT_CACHE_TTL_VAR]).toBe(SUBAGENT_CACHE_TTL);
    }
  });

  test("COMPACT_WINDOW_<ROLE> overrides; 0 turns it off; garbage fails startup naming the variable", async () => {
    const role = getRole("lead");
    const set = makeEnv({ COMPACT_WINDOW_LEAD: "150000" });
    expect(resolveCompactWindow(role, set.config)).toBe(150_000);
    expect((await optionsOf(set, "lead")).env[AUTO_COMPACT_WINDOW_VAR]).toBe("150000");
    const off = makeEnv({ COMPACT_WINDOW_LEAD: "0" });
    expect(resolveCompactWindow(role, off.config)).toBe(0);
    const offEnv = (await optionsOf(off, "lead")).env;
    expect(offEnv[AUTO_COMPACT_WINDOW_VAR]).toBeUndefined();
    expect(offEnv[AUTOCOMPACT_PCT_VAR]).toBe("75");
    expect(() => makeEnv({ COMPACT_WINDOW_LEAD: "lots" })).toThrow("COMPACT_WINDOW_LEAD");
  });

  test("range: 0 or 100000-1000000 only; anything else fails startup naming the variable, not the value", () => {
    for (const ok of ["0", "100000", "1000000"])
      expect(() => makeEnv({ COMPACT_WINDOW_LEAD: ok })).not.toThrow();
    for (const bad of ["5", "99999", "1000001", "1e3", "-1", "150000.5"]) {
      let msg = "";
      try {
        makeEnv({ COMPACT_WINDOW_LEAD: bad });
      } catch (e) {
        msg = String(e);
      }
      expect(msg).toContain("COMPACT_WINDOW_LEAD");
      expect(msg).not.toContain(bad);
    }
  });
});

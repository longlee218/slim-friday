import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/agent/run-agent";
import { sdkEnv } from "../src/agent/sdk-env";
import { loadConfig } from "../src/config/agent-config";
import { logProviderSelected } from "../src/config/log-provider";
import { createLogger } from "../src/observability/logger";
import { MASK, redactText } from "../src/observability/redact";
import { fakeQuery, makeEnv, resultMsg } from "./helpers";

// FAKE keys, concatenated so no real-looking literal sits in the source.
const OR_KEY = `sk-or-${"v1-"}${"a1b2c3d4".repeat(8)}`;
const OAUTH = `sk-ant-${"oat01-"}fakeoauthtokenvalue1234`;
const base = { AGENT_HOME: "/h" };
/** Load config from a minimal valid env plus overrides. */
const cfg = (extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra });

describe("provider resolution", () => {
  test.each([
    ["nothing set", {}, "anthropic"],
    ["key unset, oauth set", { CLAUDE_CODE_OAUTH_TOKEN: OAUTH }, "anthropic"],
    ["key placeholder", { OPENROUTER_API_KEY: "REPLACE_ME" }, "anthropic"],
    ["key real", { OPENROUTER_API_KEY: OR_KEY }, "openrouter"],
    [
      "both real -> openrouter",
      { OPENROUTER_API_KEY: OR_KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH },
      "openrouter",
    ],
    ["force anthropic", { OPENROUTER_API_KEY: OR_KEY, LLM_PROVIDER: "anthropic" }, "anthropic"],
    ["force openrouter", { LLM_PROVIDER: "openrouter" }, "openrouter"],
  ])("%s", (_n, env, provider) => {
    expect(cfg(env).provider).toBe(provider as never);
  });

  test("hasRealAuth follows the resolved provider's credential", () => {
    expect(cfg({ OPENROUTER_API_KEY: OR_KEY }).hasRealAuth).toBe(true);
    expect(cfg({ LLM_PROVIDER: "openrouter" }).hasRealAuth).toBe(false);
    expect(cfg({ LLM_PROVIDER: "openrouter", CLAUDE_CODE_OAUTH_TOKEN: OAUTH }).hasRealAuth).toBe(
      false,
    );
    expect(cfg({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH }).hasRealAuth).toBe(true);
    expect(cfg({ CLAUDE_CODE_OAUTH_TOKEN: "REPLACE_ME" }).hasRealAuth).toBe(false);
  });

  test("rejects an unknown LLM_PROVIDER", () => {
    expect(() => cfg({ LLM_PROVIDER: "foo" })).toThrow("LLM_PROVIDER");
  });
});

describe("model and budget", () => {
  test("default model per provider", () => {
    expect(cfg().model).toBe("claude-haiku-4-5-20251001");
    expect(cfg({ OPENROUTER_API_KEY: OR_KEY }).model).toBe("deepseek/deepseek-v4-flash");
  });
  test("MODEL overrides on both providers", () => {
    expect(cfg({ MODEL: "m1" }).model).toBe("m1");
    expect(cfg({ OPENROUTER_API_KEY: OR_KEY, MODEL: "x/y" }).model).toBe("x/y");
  });
  test("maxBudgetUsd: 0.5 anthropic, omitted openrouter, honored when set", () => {
    expect(cfg().limits.maxBudgetUsd).toBe(0.5);
    expect(cfg({ OPENROUTER_API_KEY: OR_KEY }).limits.maxBudgetUsd).toBeUndefined();
    expect(cfg({ OPENROUTER_API_KEY: OR_KEY, MAX_BUDGET_USD: "2" }).limits.maxBudgetUsd).toBe(2);
    expect(cfg({ MAX_BUDGET_USD: "1.5" }).limits.maxBudgetUsd).toBe(1.5);
  });
});

describe("sdkEnv per provider", () => {
  const src = { PATH: "/bin", HOME: "/h", DISCORD_TOKEN: "d", ANTHROPIC_API_KEY: "x" };
  test("openrouter env", () => {
    const c = cfg({ OPENROUTER_API_KEY: OR_KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH, MODEL: "x/y" });
    const e = sdkEnv(c, { ...src, CLAUDE_CODE_OAUTH_TOKEN: OAUTH });
    expect(e.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(e.ANTHROPIC_AUTH_TOKEN).toBe(OR_KEY);
    expect("ANTHROPIC_API_KEY" in e).toBe(true);
    expect(e.ANTHROPIC_API_KEY).toBe("");
    for (const k of [
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ])
      expect(e[k]).toBe("x/y");
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(e.DISCORD_TOKEN).toBeUndefined();
    expect(e.PATH).toBe("/bin");
  });
  test("anthropic env has no OpenRouter wiring or key", () => {
    const e = sdkEnv(
      cfg({
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
        OPENROUTER_API_KEY: OR_KEY,
        LLM_PROVIDER: "anthropic",
      }),
      src,
    );
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(JSON.stringify(e)).not.toContain(OR_KEY);
    expect(e.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(e.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect("ANTHROPIC_API_KEY" in e).toBe(false);
    expect(e.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });
});

describe("run-agent wiring", () => {
  /** Run the agent once against an injected query. */
  const go = (env: ReturnType<typeof makeEnv>, queryFn: never) =>
    runAgent({
      prompt: "q",
      taskId: "T",
      cwd: env.home,
      config: env.config,
      db: env.db,
      abortController: new AbortController(),
      queryFn,
    });

  test("openrouter omits maxBudgetUsd; explicit MAX_BUDGET_USD passes it", async () => {
    for (const [extra, want] of [
      [{}, undefined],
      [{ MAX_BUDGET_USD: "3" }, 3],
    ] as const) {
      const env = makeEnv({ OPENROUTER_API_KEY: OR_KEY, ...extra });
      let seen: any;
      await go(env, ((a: any) => {
        seen = a.options;
        return fakeQuery([resultMsg()])(a);
      }) as never);
      expect("maxBudgetUsd" in seen).toBe(want !== undefined);
      expect(seen.maxBudgetUsd).toBe(want as never);
      expect(seen.maxTurns).toBe(20);
      expect(seen.model).toBe("deepseek/deepseek-v4-flash");
    }
  });

  test("openrouter without a real key fails fast without calling the SDK", async () => {
    const env = makeEnv({ LLM_PROVIDER: "openrouter" });
    let called = false;
    const r = await go(env, (() => {
      called = true;
      return fakeQuery([])({ prompt: "" });
    }) as never);
    expect(called).toBe(false);
    expect(r.outcome).toBe("error");
  });
});

describe("edge cases", () => {
  test("MODEL empty string rejects", () => {
    expect(() => cfg({ MODEL: "" })).toThrow("MODEL");
  });
  test("MODEL whitespace-only rejects; MODEL is trimmed", () => {
    expect(() => cfg({ MODEL: "  " })).toThrow("MODEL");
    expect(cfg({ MODEL: "  x/y\n" }).model).toBe("x/y");
  });
  test("secrets are trimmed and reach sdkEnv trimmed", () => {
    const c = cfg({ OPENROUTER_API_KEY: `  ${OR_KEY}\n` });
    expect(c.hasRealAuth).toBe(true);
    expect(sdkEnv(c, {}).ANTHROPIC_AUTH_TOKEN).toBe(OR_KEY);
    const a = cfg({ CLAUDE_CODE_OAUTH_TOKEN: `${OAUTH}\r\n`, DISCORD_TOKEN: " d \n" });
    expect(sdkEnv(a, {}).CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(a.discordToken).toBe("d");
  });
  test("secret empty or whitespace-only after trim counts as unset", () => {
    const c = cfg({ OPENROUTER_API_KEY: " \n", CLAUDE_CODE_OAUTH_TOKEN: "" });
    expect(c.provider).toBe("anthropic");
    expect(c.openrouterApiKey).toBeUndefined();
    expect(c.hasRealAuth).toBe(false);
  });
  test("both keys as REPLACE_ME defaults to anthropic with no auth", () => {
    const c = cfg({
      OPENROUTER_API_KEY: "REPLACE_ME",
      CLAUDE_CODE_OAUTH_TOKEN: "REPLACE_ME",
    });
    expect(c.provider).toBe("anthropic");
    expect(c.hasRealAuth).toBe(false);
  });
  test("LLM_PROVIDER=openrouter + only OAuth token has no real auth", () => {
    const c = cfg({ LLM_PROVIDER: "openrouter", CLAUDE_CODE_OAUTH_TOKEN: OAUTH });
    expect(c.provider).toBe("openrouter");
    expect(c.hasRealAuth).toBe(false);
  });
});

describe("secrets", () => {
  test("redactText masks OpenRouter keys", () => {
    expect(redactText(`key ${OR_KEY} end`)).toBe(`key ${MASK} end`);
    expect(redactText(`x sk-or-${"abcdefgh12"}`)).toBe(`x ${MASK}`);
  });
  test("redactText masks sk-or-v1- pattern specifically", () => {
    const sk_or_v1 = "sk-or-v1-" + "x".repeat(20);
    expect(redactText(`secret is ${sk_or_v1} here`)).toBe(`secret is ${MASK} here`);
  });
  test("redactText masks OpenRouter key inside JSON", () => {
    const json = JSON.stringify({ key: OR_KEY, nested: { key: OR_KEY } });
    const redacted = redactText(json);
    expect(redacted).not.toContain("sk-or-");
  });
  test("redactText masks OpenRouter key in URL query string", () => {
    const url = `https://openrouter.ai/api?auth=${OR_KEY}`;
    const redacted = redactText(url);
    expect(redacted).not.toContain("sk-or-");
  });
  test("startup log has provider and model but no secret", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s: string) => void lines.push(s) } as never);
    logProviderSelected(log, cfg({ OPENROUTER_API_KEY: OR_KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH }));
    const out = lines.join("");
    expect(out).toContain("openrouter");
    expect(out).toContain("deepseek/deepseek-v4-flash");
    expect(out).not.toContain(OR_KEY);
    expect(out).not.toContain(OAUTH);
  });
  test("warns when both credentials are real and LLM_PROVIDER is unset", () => {
    const warn = (extra: Record<string, string>) => {
      const lines: string[] = [];
      const log = createLogger({ write: (s: string) => void lines.push(s) } as never);
      logProviderSelected(
        log,
        cfg({ OPENROUTER_API_KEY: OR_KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ...extra }),
      );
      return lines.join("");
    };
    const msg = "both credentials set; using openrouter (set LLM_PROVIDER=anthropic to change)";
    expect(warn({})).toContain(msg);
    expect(warn({ LLM_PROVIDER: "openrouter" })).not.toContain("both credentials");
    expect(warn({})).not.toContain(OR_KEY);
  });
  test("pino censors the new key names", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s: string) => void lines.push(s) } as never);
    log.info({ openrouterApiKey: OR_KEY, oauthToken: OAUTH, x: { openrouterApiKey: OR_KEY } }, "m");
    expect(lines.join("")).not.toContain("sk-or-");
    expect(lines.join("")).not.toContain("sk-ant-");
  });
});

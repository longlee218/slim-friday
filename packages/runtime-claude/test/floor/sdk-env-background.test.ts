import { expect, test } from "bun:test";
import { sdkEnv } from "../../src/floor/sdk-env";
import { workerSandbox } from "../../src/floor/worker-sandbox";

const AUTH = { hasRealAuth: true, oauthToken: "tok" };

test("allowBackground leaves the background-task switch unset", () => {
  const on = sdkEnv(AUTH, { PATH: "/bin" }, { worker: true, allowBackground: true });
  expect("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS" in on).toBe(false);
  const off = sdkEnv(AUTH, { PATH: "/bin" }, { worker: true });
  expect(off.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
});

test("a worker env has the subprocess scrub on and no app secrets", () => {
  const env = sdkEnv(
    AUTH,
    {
      PATH: "/bin",
      HOME: "/h",
      DISCORD_TOKEN: "d",
      VIEWER_SECRET: "v",
      GITHUB_TOKEN: "g",
      AWS_SECRET_ACCESS_KEY: "a",
    },
    { worker: true, allowBackground: true },
  );
  expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  for (const name of ["DISCORD_TOKEN", "VIEWER_SECRET", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"])
    expect(name in env).toBe(false);
  expect(env.PATH).toBe("/bin");
  expect(env.HOME).toBe("/h");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
});

test("the OAuth token comes only from config, never from the source env", () => {
  const env = sdkEnv({ hasRealAuth: false }, { CLAUDE_CODE_OAUTH_TOKEN: "leak" }, { worker: true });
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
});

test("the sandbox writes only the write paths and the scratch dir", () => {
  const sb = workerSandbox({ writePaths: ["/w"], scratchDir: "/s", cwd: "/w" });
  expect([...(sb?.filesystem?.allowWrite ?? [])].sort()).toEqual(["/s", "/w"]);
});

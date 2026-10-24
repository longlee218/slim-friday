import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHILD_ENV_DENY,
  isChildEnvDenied,
} from "../../../packages/runtime-claude/src/floor/child-env-deny";
import { ENV_SCHEMA_KEYS } from "../src/config/agent-config";

describe("child env deny list (config/data/child-env-deny.yaml)", () => {
  test("every key of the env schema is classified: denied or on the passthrough list", () => {
    const unclassified = ENV_SCHEMA_KEYS.filter(
      (k) => !isChildEnvDenied(k) && !CHILD_ENV_DENY.passthrough.includes(k),
    );
    // A new app variable must be added to the deny list (or, on purpose, to `passthrough`).
    expect(unclassified).toEqual([]);
  });

  test("the retired artifact-viewer vars stay denied (a stale .env may still set VIEWER_SECRET)", () => {
    for (const k of ["VIEWER_SECRET", "VIEWER_BASE_URL", "VIEWER_PORT", "VIEWER_LINK_TTL_MS"])
      expect(isChildEnvDenied(k)).toBe(true);
  });

  test("the schema is read at all (a renamed export cannot make the check above vacuous)", () => {
    expect(ENV_SCHEMA_KEYS).toEqual(expect.arrayContaining(["R2_BUCKET", "AGENT_HOME"]));
  });

  test("the vars named in the phase spec are denied, by exact name and by prefix", () => {
    for (const k of [
      ...["CLAUDE_CODE_OAUTH_TOKEN", "AGENT_HOME", "LOG_LEVEL"],
      ...["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
      ...["MODEL", "MEMORY_MODEL"],
      ...["GIT_AUTHOR", "MAX_TURNS", "MAX_BUDGET_USD", "TIMEOUT_MS", "MAX_CONCURRENT_RUNS"],
      ...["API_PORT", "WEB_ORIGIN", "AUTH_SECRET", "OWNER_EMAIL", "PUBLIC_API_URL"],
      ...["MODEL_HAIKU", "MODEL_DEV", "BUDGET_DEV_USD", "COMPACT_WINDOW_DEV"],
      ...[
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "FRIDAY_ANYTHING",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
      ],
      ...[
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
        "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
        "CLAUDE_CODE_PROMPT_CACHE_TTL",
        "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
      ],
    ])
      expect([k, isChildEnvDenied(k)]).toEqual([k, true]);
  });

  test("child env deny list covers the R2 names and no name of the removed chat app remains", () => {
    const yaml = readFileSync(
      join(import.meta.dir, "../../../packages/runtime-claude/src/floor/data/child-env-deny.yaml"),
      "utf8",
    );
    for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"])
      expect(CHILD_ENV_DENY.exact).toContain(k);
    // The removed app's name is built from parts: `apps` and `packages` must not hold it as a literal.
    const removed = new RegExp(["dis", "cord"].join(""), "i");
    expect(yaml).not.toMatch(removed);
    expect(ENV_SCHEMA_KEYS.filter((k) => removed.test(k))).toEqual([]);
  });

  test("the owner's own variables are not denied", () => {
    for (const k of [
      ...["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "CLAUDE_CONFIG_DIR", "SSH_AUTH_SOCK"],
      ...["GH_TOKEN", "GITHUB_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "HTTPS_PROXY"],
      ...["AWS_PROFILE", "XDG_CONFIG_HOME", "MODELS_DIR", "BUDGETING"],
    ])
      expect([k, isChildEnvDenied(k)]).toEqual([k, false]);
  });
});

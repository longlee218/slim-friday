import { describe, expect, test } from "bun:test";
import { ENV_SCHEMA_KEYS } from "../src/config/agent-config";
import { CHILD_ENV_DENY, isChildEnvDenied } from "../src/config/child-env-deny";

describe("child env deny list (config/data/child-env-deny.yaml)", () => {
  test("every key of the env schema is classified: denied or on the passthrough list", () => {
    const unclassified = ENV_SCHEMA_KEYS.filter(
      (k) => !isChildEnvDenied(k) && !CHILD_ENV_DENY.passthrough.includes(k),
    );
    // A new app variable must be added to the deny list (or, on purpose, to `passthrough`).
    expect(unclassified).toEqual([]);
  });

  test("the schema is read at all (a renamed export cannot make the check above vacuous)", () => {
    expect(ENV_SCHEMA_KEYS).toEqual(expect.arrayContaining(["DISCORD_TOKEN", "AGENT_HOME"]));
  });

  test("the vars named in the phase spec are denied, by exact name and by prefix", () => {
    for (const k of [
      ...[
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENROUTER_API_KEY",
        "LLM_PROVIDER",
        "AGENT_HOME",
        "LOG_LEVEL",
      ],
      ...["DISCORD_TOKEN", "OWNER_DISCORD_ID", "DISCORD_GUILD_ID", "MODEL", "MEMORY_MODEL"],
      ...["GIT_AUTHOR", "MAX_TURNS", "MAX_BUDGET_USD", "TIMEOUT_MS", "MAX_CONCURRENT_RUNS"],
      ...["INTENT_ENGINE", "INTENT_BUDGET_USD", "MODEL_INTENT", "CLONE_RETENTION_DAYS"],
      ...["MODEL_HAIKU", "MODEL_DEV_EXEC", "BUDGET_DEV_EXEC_USD", "COMPACT_WINDOW_ASSISTANT_QA"],
      ...[
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "FRIDAY_ANYTHING",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
      ],
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    ])
      expect([k, isChildEnvDenied(k)]).toEqual([k, true]);
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

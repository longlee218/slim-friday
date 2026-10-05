import type { Logger } from "pino";
import type { AgentConfig } from "./agent-config";

/** Log one startup line naming the provider and model, plus a warning when the choice is implicit. Never includes credentials. */
export function logProviderSelected(log: Logger, config: AgentConfig): void {
  log.info({ provider: config.provider, model: config.model }, "llm provider selected");
  if (config.ambiguousCredentials)
    log.warn("both credentials set; using openrouter (set LLM_PROVIDER=anthropic to change)");
}

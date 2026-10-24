import type { AgentConfig } from "./config/agent-config";

/** A required value: missing and the `REPLACE_ME` placeholder both count as absent. */
export function need(name: string, value: string | undefined): string {
  if (!value || value === "REPLACE_ME") throw new Error(`${name} missing`);
  return value;
}

/** The R2 credentials and bucket; refuses by variable name when one is missing. */
export function r2Of(config: AgentConfig) {
  return {
    accountId: need("R2_ACCOUNT_ID", config.r2.accountId),
    accessKeyId: need("R2_ACCESS_KEY_ID", config.r2.accessKeyId),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY", config.r2.secretAccessKey),
    bucket: need("R2_BUCKET", config.r2.bucket),
  };
}

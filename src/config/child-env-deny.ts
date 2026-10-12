import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shape of `data/child-env-deny.yaml`. */
interface ChildEnvDeny {
  exact: string[];
  prefixes: string[];
  passthrough: string[];
}

/** The deny list of the child env: data, so adding an app variable is a data change (the unit test enforces it). */
export const CHILD_ENV_DENY: ChildEnvDeny = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "data", "child-env-deny.yaml"), "utf8"),
) as ChildEnvDeny;

const EXACT = new Set(CHILD_ENV_DENY.exact);

/** True when the bot's variable `name` must not reach the agent's process (exact name or prefix). */
export const isChildEnvDenied = (name: string): boolean =>
  EXACT.has(name) || CHILD_ENV_DENY.prefixes.some((p) => name.startsWith(p));

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shape of `data/child-env-deny.yaml`. */
interface ChildEnvDeny {
  exact: string[];
  prefixes: string[];
  passthrough: string[];
  /** Extra denies for a dispatched worker's process (secrets of the owner: tokens, keys, cloud and git auth). */
  worker: { exact: string[]; prefixes: string[]; pattern: string; keep: string[] };
}

/** The deny list of the child env: data, so adding an app variable is a data change (the unit test enforces it). */
export const CHILD_ENV_DENY: ChildEnvDeny = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "data", "child-env-deny.yaml"), "utf8"),
) as ChildEnvDeny;

const EXACT = new Set(CHILD_ENV_DENY.exact);

/** True when the bot's variable `name` must not reach the agent's process (exact name or prefix). */
export const isChildEnvDenied = (name: string): boolean =>
  EXACT.has(name) || CHILD_ENV_DENY.prefixes.some((p) => name.startsWith(p));

/** Secret-looking name (`API_KEY`, `MY_TOKEN`): the yaml's word pattern. */
const WORKER_PATTERN = new RegExp(CHILD_ENV_DENY.worker.pattern, "i");

/**
 * True when the variable `name` must not reach a dispatched WORKER's process (its Bash tool runs repo code): everything the bot
 * denies, plus tokens, keys, secrets, passwords, cloud / git / gh auth and git's own switches (identity names kept).
 */
export const isWorkerEnvDenied = (name: string): boolean => {
  const w = CHILD_ENV_DENY.worker;
  if (w.keep.includes(name)) return isChildEnvDenied(name);
  return (
    isChildEnvDenied(name) ||
    w.exact.includes(name) ||
    w.prefixes.some((p) => name.startsWith(p)) ||
    WORKER_PATTERN.test(name)
  );
};

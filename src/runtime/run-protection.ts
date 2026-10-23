import type { GuardrailContext } from "../policy/check-tool-call";
import type { RoleDefinition } from "../roles/role-types";
import type { ToolPolicy } from "../tools/derive-tool-policy";

/* What protects a run, derived from the role's tool policy (not from "has an envelope"): a worker keeps every protection it
   has always had; a teammate that was given a shell or an effect tool gets the same ones. */

/** The protections of one run. */
export interface RunProtection {
  /** The shell (and any file tool the OS reaches) runs in the OS sandbox. */
  sandbox: boolean;
  /** The run's own dir: a worker's goal dir, or a teammate's run dir. Undefined = the run has none. */
  scratchDir?: string;
  /** Nothing is auto-approved: the permission mode is `default` (a guard `ask` reaches the owner). */
  permissionDefault: boolean;
  /** Secret-like env vars are dropped and the SDK scrubs the credentials from its subprocesses. */
  scrubEnv: boolean;
}

/** Risk classes from which a tool call may change the world (the effect tools): the owner is asked, never a classifier. */
const RISKY = ["R2", "R3", "R4"];

/**
 * A dispatched worker is always protected (it runs repo code behind an envelope). Any other run is protected exactly when its tools
 * can run code (shell) or act outside the sandbox (an R2 or higher tool); the default teammate (read, skills, memory,
 * orchestration) is not, so it keeps its `auto` mode and plain env.
 */
export function runProtection(
  role: RoleDefinition,
  policy: ToolPolicy,
  guard?: Pick<GuardrailContext, "envelope" | "scratchDir">,
): RunProtection {
  // A dispatched worker = a worker role with its envelope (a worker role without one only exists in a unit test).
  const dispatched = role.kind === "worker" && !!guard?.envelope;
  const protectedRun = dispatched || policy.shell;
  const scratchDir = guard?.envelope?.goalDir ?? guard?.scratchDir;
  // Fail closed: a teammate shell with no run dir would run unsandboxed (a worker without an envelope is a test seam).
  if (role.kind !== "worker" && policy.shell && !scratchDir)
    throw new Error(`${role.name}: a run with a shell needs its own scratch dir`);
  return {
    sandbox: protectedRun,
    scratchDir,
    permissionDefault: protectedRun || RISKY.includes(policy.maxRisk),
    scrubEnv: protectedRun,
  };
}

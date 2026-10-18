import type { FlowResult } from "../turns/turn-result";
import type { DispatchDeps, RoleRunInput } from "./role-run-types";
import { runRole } from "./run-role";

/**
 * Run the role of `input` and close its turn row through `finish` (which calls `closeTurn`). A crash is handed to
 * `onCrash` (`closing` = it came from the close step): the lead marks the row `failed`; a detached worker recovers its
 * item. Rethrows every crash.
 */
export async function runAndClose<R>(
  deps: DispatchDeps,
  input: RoleRunInput,
  onCrash: (closing: boolean) => void,
  finish: (res: FlowResult) => R,
): Promise<{ res: FlowResult; closed: R }> {
  let closing = false;
  try {
    const res = await runRole(deps, input);
    closing = true;
    return { res, closed: finish(res) };
  } catch (err) {
    onCrash(closing); // a crashed run must still release its turn row
    throw err;
  }
}

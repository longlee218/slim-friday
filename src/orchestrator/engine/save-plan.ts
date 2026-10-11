import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../../config/workspace-paths";
import { logger, tryLog } from "../../observability/logger";
import { setTaskRepo } from "../../storage/run-store";
import type { StageRunInput, StageRunnerDeps } from "./stage-runner";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "save-plan" });

/**
 * Best effort: keep the approved plan (in the file the exec handoff names) and the repo on the task row. Used when the
 * stage switch fails before a clone exists (no commit identity): `/go` can then run the switch again.
 */
export function savePlanForResume(
  deps: StageRunnerDeps,
  i: StageRunInput,
  repo: string,
  planFile: string,
  plan: string,
): void {
  tryLog(log, "saving the approved plan failed", () => {
    const dir = workspacePaths(deps.config.agentHome).workspace(i.workspace).task(i.taskId).root;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, planFile), plan);
    setTaskRepo(deps.db, i.taskId, repo);
  });
}

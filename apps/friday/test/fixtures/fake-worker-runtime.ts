import { writeFileSync } from "node:fs";
import { FakeFileStore } from "../../../../packages/core/test/fakes/fake-file-store";
import { FakeRuntime } from "../../../../packages/core/test/fakes/fake-runtime";

/**
 * The test seam a worker process loads with `--runtime-module` (worker-flow tests): a fake runtime that echoes
 * the owner's text, never ends a turn whose text holds "hang", ignores its stop when the text holds "stuck" (and, given
 * "stuck <path>", starts a long `sleep` child as an SDK-child stand-in and writes its pid to <path>), and answers a turn carrying the cut note with
 * "resumed: <text>".
 */
export function createRuntime() {
  const runtime = new FakeRuntime();
  runtime.onTurn = (s, turn) => {
    if (turn.interrupted) {
      s.emit({ type: "text", text: `resumed: ${turn.text}` });
      s.emit({ type: "turn_end", costUsd: 0 });
      return;
    }
    if (turn.text.includes("hang")) return;
    // A session that ignores its stop: the run never settles.
    if (turn.text.includes("stuck")) {
      const pidFile = /stuck (\/\S+)/.exec(turn.text)?.[1];
      if (pidFile) {
        const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
        writeFileSync(pidFile, String(child.pid));
      }
      s.stop = () => new Promise(() => {});
      return;
    }
    s.emit({ type: "text", text: `echo: ${turn.text}` });
    s.emit({ type: "turn_end", costUsd: 0 });
  };
  return runtime;
}

/** Files stay in memory. */
export const createFiles = () => new FakeFileStore();

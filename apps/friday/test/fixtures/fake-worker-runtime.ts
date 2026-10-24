import { FakeFileStore } from "../../../../packages/core/test/fakes/fake-file-store";
import { FakeRuntime } from "../../../../packages/core/test/fakes/fake-runtime";

/**
 * The test seam a worker process loads with `--runtime-module` (worker-flow tests): a fake runtime that echoes
 * the owner's text, never ends a turn whose text holds "hang", and answers a turn carrying the cut note with
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
    s.emit({ type: "text", text: `echo: ${turn.text}` });
    s.emit({ type: "turn_end", costUsd: 0 });
  };
  return runtime;
}

/** Files stay in memory. */
export const createFiles = () => new FakeFileStore();

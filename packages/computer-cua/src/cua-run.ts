import type { ExecResult } from "@friday/core";

/** Run one command to the end: argv without the binary, a time limit in ms. The test seam of the provider. */
export type CuaRun = (argv: string[], timeoutMs: number) => Promise<ExecResult>;

/** The only env values a child gets besides telemetry off: PATH and HOME from the caller's options. */
export interface RunEnv {
  PATH: string;
  HOME: string;
}

/** The complete child env. */
export const childEnv = (env: RunEnv): Record<string, string> => ({
  PATH: env.PATH,
  HOME: env.HOME,
  DO_NOT_TRACK: "1",
});

/** Most bytes kept per output stream; more is cut, flagged and the child is killed. */
export const OUTPUT_CAP = 4 * 1024 * 1024;
const TRUNCATED = "\n[output truncated]";

/** Reads one stream into a capped buffer; `cancel` stops the read even when a grandchild holds the pipe open. */
function collect(stream: ReadableStream<Uint8Array>, onCap: () => void) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cut = false;
  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        const room = OUTPUT_CAP - total;
        if (value.length > room) {
          chunks.push(value.slice(0, room));
          total = OUTPUT_CAP;
          cut = true;
          onCap();
          break;
        }
        chunks.push(value);
        total += value.length;
      }
    } catch {
      // a cancelled read ends the collection
    }
  })();
  return {
    done,
    cancel: () => void reader.cancel().catch(() => {}),
    text: () => `${Buffer.concat(chunks).toString("utf8")}${cut ? TRUNCATED : ""}`,
  };
}

/**
 * A runner for `binary` with `prefix` args in front (e.g. `--json`). argv, no shell, minimal env. Each output
 * stream is capped at 4 MB (cut, flagged, child killed). On timeout the child is killed and the result is code 124
 * (the exit code `cua` itself uses) right away, even if a grandchild keeps a pipe open.
 */
export function makeRunner(binary: string, prefix: string[], env: RunEnv): CuaRun {
  return async (argv, timeoutMs) => {
    const proc = Bun.spawn([binary, ...prefix, ...argv], {
      env: childEnv(env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const kill = () => proc.kill("SIGKILL");
    const out = collect(proc.stdout, kill);
    const err = collect(proc.stderr, kill);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([Promise.all([out.done, err.done, proc.exited]), timeout]);
      if (timedOut) {
        out.cancel();
        err.cancel();
        return {
          code: 124,
          stdout: out.text(),
          stderr: `${err.text()}timed out after ${timeoutMs} ms`,
        };
      }
      return { code: await proc.exited, stdout: out.text(), stderr: err.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}

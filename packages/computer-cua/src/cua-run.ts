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

/**
 * A runner for `binary` with `prefix` args in front (e.g. `--json`). argv, no shell, minimal env; on timeout the
 * child is killed and the result is code 124 (the exit code `cua` itself uses for a timeout).
 */
export function makeRunner(binary: string, prefix: string[], env: RunEnv): CuaRun {
  return async (argv, timeoutMs) => {
    const proc = Bun.spawn([binary, ...prefix, ...argv], {
      env: childEnv(env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (timedOut)
        return { code: 124, stdout, stderr: `${stderr}timed out after ${timeoutMs} ms` };
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}

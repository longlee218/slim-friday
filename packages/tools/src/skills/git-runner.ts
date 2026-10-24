/** Runs git with an argv and env; resolves with its exit code and output. Tests pass a fake. */
export type GitRunner = (
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<{ code: number; out: string; err: string }>;

/** Most bytes kept of one captured stream. */
const OUT_CAP = 64 * 1024;

/** Read a stream to the end but keep only the first `OUT_CAP` bytes (the rest is drained and dropped). */
async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size < OUT_CAP) chunks.push(chunk.subarray(0, OUT_CAP - size));
    size += chunk.length;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The default runner: `Bun.spawn` in its own process group (so a grandchild such as `git-remote-https` dies with
 * it), output capped at 64 KB per stream. On timeout the group gets SIGTERM, then SIGKILL after 2 s, and the promise
 * resolves with code -1 whatever the pipes do: it never waits on a grandchild that holds them open.
 */
export const defaultGitRunner: GitRunner = async (argv, env, timeoutMs) => {
  const proc = Bun.spawn(argv, {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });
  const killGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      // the group is already gone
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      killGroup("SIGTERM");
      hardTimer = setTimeout(() => killGroup("SIGKILL"), 2000);
      resolve("timeout");
    }, timeoutMs);
  });
  const done = (async () => {
    const [out, err, code] = await Promise.all([
      readCapped(proc.stdout),
      readCapped(proc.stderr),
      proc.exited,
    ]);
    return { code, out, err };
  })();
  done.catch(() => {});
  try {
    const r = await Promise.race([done, timedOut]);
    if (r === "timeout") return { code: -1, out: "", err: "timed out" };
    return r;
  } finally {
    clearTimeout(timer);
    // After a timeout the SIGKILL timer stays armed (unref'd) so a stubborn group is still killed.
    hardTimer?.unref();
  }
};

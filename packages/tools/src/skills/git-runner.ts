/** Runs git with an argv and env; resolves with its exit code and output. Tests pass a fake. */
export type GitRunner = (
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number,
  maxOutputBytes?: number,
) => Promise<{ code: number; out: string; err: string; truncated: boolean }>;

/** Default most bytes kept of one captured stream. */
export const DEFAULT_OUTPUT_CAP = 64 * 1024;

/** Read a stream to the end but keep only the first `cap` bytes (the rest is drained and dropped); flags the cut. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ text: string; cut: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size < cap) chunks.push(chunk.subarray(0, cap - size));
    size += chunk.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), cut: size > cap };
}

/**
 * The default runner: `Bun.spawn` in its own process group (so a grandchild such as `git-remote-https` dies with
 * it), output capped (64 KB per stream unless the call asks for more, `truncated` says so). On timeout the group gets SIGTERM, then SIGKILL after 2 s, and the promise
 * resolves with code -1 whatever the pipes do: it never waits on a grandchild that holds them open.
 */
export const defaultGitRunner: GitRunner = async (
  argv,
  env,
  timeoutMs,
  maxOutputBytes = DEFAULT_OUTPUT_CAP,
) => {
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
      readCapped(proc.stdout, maxOutputBytes),
      readCapped(proc.stderr, maxOutputBytes),
      proc.exited,
    ]);
    // The process is gone: its group id may be reused, so the pending SIGKILL must never fire.
    clearTimeout(hardTimer);
    return { code, out: out.text, err: err.text, truncated: out.cut || err.cut };
  })();
  done.catch(() => {});
  try {
    const r = await Promise.race([done, timedOut]);
    if (r === "timeout") return { code: -1, out: "", err: "timed out", truncated: false };
    return r;
  } finally {
    clearTimeout(timer);
    // After a timeout the SIGKILL timer stays armed (unref'd) so a stubborn group is still killed.
    hardTimer?.unref();
  }
};

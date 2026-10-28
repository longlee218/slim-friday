import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ComputerCapacity,
  ComputerProvider,
  ComputerSpec,
  DesktopAction,
  ExecResult,
  Screenshot,
} from "@friday/core";
import { int, isRunning, must, pngSize } from "./cua-parse";
import type { PortForwards } from "./cua-port-forward";
import type { CuaRun } from "./cua-run";
import { assertComputerName, ENV_NAME, shellLine, shellQuote } from "./cua-safe";

/*
 * Command mapping: every `cua` argv this adapter builds lives in `cmd` below.
 * Verified against Cua 0.9.0 in the spike: sandbox create/info/restart/port-forward/rm.
 * Everything else is read from docs only and marked UNVERIFIED (Ruling 8): confirm with the live check.
 */
const cmd = {
  info: (n: string) => ["sandbox", "info", n],
  create: (s: ComputerSpec) => [
    "sandbox",
    "create",
    "linux",
    "--tier",
    "slim",
    "--name",
    s.name,
    "--cpu",
    String(s.cpus),
    "--memory",
    `${s.memoryMb}MB`,
  ],
  restart: (n: string) => ["sandbox", "restart", n],
  // UNVERIFIED: confirm with the live check (docs: options before NAME, joined into one `sh -c` line).
  exec: (n: string, secs: number, line: string) => [
    "sandbox",
    "exec",
    n,
    "--timeout",
    String(secs),
    line,
  ],
  // UNVERIFIED: confirm with the live check (docs list `suspend` for pause/snapshot; there is no `sandbox stop`).
  stop: (n: string) => ["sandbox", "suspend", n],
  // UNVERIFIED: confirm with the live check (`do` acts on the sandbox chosen by `do switch`; `local:` ref from docs).
  select: (n: string) => ["do", "switch", `local:${n}`],
  // UNVERIFIED: confirm with the live check.
  shot: (file: string) => ["do", "screenshot", "--save", file],
  // UNVERIFIED: confirm with the live check.
  click: (x: number, y: number, b: string) => ["do", "click", String(x), String(y), b],
  dclick: (x: number, y: number) => ["do", "dclick", String(x), String(y)], // UNVERIFIED: confirm with the live check.
  type: (text: string) => ["do", "type", "--", text], // UNVERIFIED: confirm with the live check (`--` ends options).
  key: (k: string) => ["do", k.includes("+") ? "hotkey" : "key", "--", k], // UNVERIFIED: confirm with the live check.
  scroll: (dir: string, amount: number) => ["do", "scroll", dir, String(amount)], // UNVERIFIED: unit of AMOUNT.
  drag: (a: number, b: number, c: number, d: number) => ["do", "drag", ...[a, b, c, d].map(String)], // UNVERIFIED
  tree: () => ["do", "a11y", "tree"], // UNVERIFIED: confirm with the live check (stdout is returned as is).
};

/** What the provider needs: the runners are the test seam. */
export interface CuaProviderDeps {
  /** Runs `cua --json <argv>`. */
  run: CuaRun;
  /** Runs `docker <argv>` (capacity). */
  docker: CuaRun;
  forwards: PortForwards;
}

const QUICK_MS = 30_000;
const CREATE_MS = 300_000;
const MAX_WAIT_MS = 60_000;

/** The ComputerProvider over the `cua` CLI. One instance serves every computer by name. */
export function createCuaProvider(deps: CuaProviderDeps): ComputerProvider {
  const { run, docker, forwards } = deps;
  // `do` acts on the one selected sandbox, so select + act is a critical section.
  let desk: Promise<unknown> = Promise.resolve();
  const onDesk = <T>(
    name: string,
    steps: (go: (argv: string[]) => Promise<ExecResult>) => Promise<T>,
  ) => {
    const go = async (argv: string[]) => must(argv, await run(argv, QUICK_MS));
    const job = desk.then(async () => {
      await go(cmd.select(name));
      return steps(go);
    });
    desk = job.catch(() => {});
    return job;
  };

  async function exec(name: string, line: string, timeoutMs: number): Promise<ExecResult> {
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    return run(cmd.exec(name, secs, line), timeoutMs + 5000);
  }

  async function scroll(
    a: Extract<DesktopAction, { kind: "scroll" }>,
    go: (v: string[]) => Promise<ExecResult>,
  ) {
    const step = (n: number) => Math.max(1, Math.round(Math.abs(n) / 100));
    if (a.dy) await go(cmd.scroll(a.dy > 0 ? "down" : "up", step(a.dy)));
    if (a.dx) await go(cmd.scroll(a.dx > 0 ? "right" : "left", step(a.dx)));
  }

  return {
    async capacity(): Promise<ComputerCapacity> {
      const argv = ["info", "--format", "{{json .}}"];
      const j = JSON.parse(must(argv, await docker(argv, QUICK_MS)).stdout) as {
        NCPU?: number;
        MemTotal?: number;
      };
      if (!j.NCPU || !j.MemTotal) throw new Error("docker info gave no NCPU or MemTotal");
      return { cpus: j.NCPU, memoryMb: Math.floor(j.MemTotal / 1024 / 1024) };
    },
    async ensure(spec) {
      const name = assertComputerName(spec.name);
      const info = await run(cmd.info(name), QUICK_MS);
      if (info.code !== 0) {
        const argv = cmd.create({ ...spec, name });
        must(argv, await run(argv, CREATE_MS));
      } else if (!isRunning(info.stdout)) {
        must(cmd.restart(name), await run(cmd.restart(name), CREATE_MS));
      }
    },
    async exec(name, argv, timeoutMs) {
      assertComputerName(name);
      return exec(name, shellLine(argv), timeoutMs);
    },
    async launch(name, argv, env) {
      assertComputerName(name);
      const vars = Object.entries(env).map(([k, v]) => {
        if (!ENV_NAME.test(k)) throw new Error("launch env name must match [A-Za-z_][A-Za-z0-9_]*");
        return shellQuote(`${k}=${v}`);
      });
      const envPart = vars.length ? `env ${vars.join(" ")} ` : "";
      const line = `setsid nohup ${envPart}${shellLine(argv)} >/tmp/${name}.log 2>&1 &`;
      const res = await exec(name, line, QUICK_MS);
      must(["sandbox", "exec"], res);
    },
    async screenshot(name): Promise<Screenshot> {
      assertComputerName(name);
      const dir = await mkdtemp(join(tmpdir(), "friday-cua-"));
      try {
        const file = join(dir, "shot.png");
        await onDesk(name, (go) => go(cmd.shot(file)));
        const png = new Uint8Array(await readFile(file));
        return { png, ...pngSize(png) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async act(name, a) {
      assertComputerName(name);
      if (a.kind === "wait") {
        await Bun.sleep(Math.min(Math.max(0, int(a.ms, "ms")), MAX_WAIT_MS));
        return;
      }
      await onDesk(name, async (go) => {
        if (a.kind === "click") {
          const x = int(a.x, "x");
          const y = int(a.y, "y");
          if (a.double) {
            if (a.button === "right") throw new Error("a double click is left only");
            await go(cmd.dclick(x, y));
          } else await go(cmd.click(x, y, a.button ?? "left"));
        } else if (a.kind === "type") await go(cmd.type(a.text));
        else if (a.kind === "key") await go(cmd.key(a.keys));
        else if (a.kind === "scroll")
          await scroll({ ...a, dx: int(a.dx, "dx"), dy: int(a.dy, "dy") }, go);
        else {
          const [p, q, r, s] = [a.fromX, a.fromY, a.toX, a.toY].map((n) => int(n, "drag point"));
          await go(cmd.drag(p as number, q as number, r as number, s as number));
        }
      });
    },
    async accessibilityTree(name) {
      assertComputerName(name);
      return onDesk(name, async (go) => (await go(cmd.tree())).stdout);
    },
    async forwardPort(name, guestPort) {
      return forwards.forward(assertComputerName(name), guestPort);
    },
    async stop(name) {
      assertComputerName(name);
      forwards.closeAll(name);
      must(cmd.stop(name), await run(cmd.stop(name), QUICK_MS));
    },
  };
}

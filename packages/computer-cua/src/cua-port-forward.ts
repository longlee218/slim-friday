import { createServer } from "node:net";
import { childEnv, type RunEnv } from "./cua-run";
import { assertComputerName } from "./cua-safe";

/** A long-lived child process. */
export interface Child {
  kill(): void;
}

/** Seams of the forwarder (real ones below; tests fake them). */
export interface ForwardDeps {
  spawn(argv: string[]): Child;
  freePort(): Promise<number>;
  waitReady(port: number): Promise<void>;
}

/** Host-side ports reaching guest ports, one long-lived `cua sandbox port-forward` child per name and port. */
export interface PortForwards {
  /** `http://127.0.0.1:<port>` for the guest port; idempotent per name and port. */
  forward(name: string, guestPort: number): Promise<string>;
  /** Kill every forward of a computer. */
  closeAll(name: string): void;
}

/** A TCP port nobody listens on right now. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

/** Wait until something accepts on the local port (up to 15 s). */
export async function waitReady(port: number): Promise<void> {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    try {
      const sock = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: { data() {} },
      });
      sock.end();
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`port forward to 127.0.0.1:${port} did not open in time`);
}

/** The forwarder for `binary`; `deps` default to real processes. */
export function makePortForwards(
  binary: string,
  env: RunEnv,
  deps: Partial<ForwardDeps> = {},
): PortForwards {
  const spawn =
    deps.spawn ??
    ((argv: string[]) =>
      Bun.spawn([binary, ...argv], {
        env: childEnv(env),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }));
  const pick = deps.freePort ?? freePort;
  const ready = deps.waitReady ?? waitReady;
  const live = new Map<string, { child: Child; url: string }>();
  const pending = new Map<string, Promise<string>>();
  return {
    async forward(name, guestPort) {
      assertComputerName(name);
      if (!Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535)
        throw new Error("guestPort must be an integer from 1 to 65535");
      const key = `${name}:${guestPort}`;
      const known = live.get(key);
      if (known) return known.url;
      const inflight = pending.get(key);
      if (inflight) return inflight;
      const p = (async () => {
        const local = await pick();
        // UNVERIFIED: confirm with the live check (`PORT:LOCAL_PORT` spec is from the docs only).
        const child = spawn(["sandbox", "port-forward", name, `${guestPort}:${local}`]);
        try {
          await ready(local);
        } catch (err) {
          child.kill();
          throw err;
        }
        const url = `http://127.0.0.1:${local}`;
        live.set(key, { child, url });
        return url;
      })().finally(() => pending.delete(key));
      pending.set(key, p);
      return p;
    },
    closeAll(name) {
      for (const [key, f] of live) {
        if (key.startsWith(`${name}:`)) {
          f.child.kill();
          live.delete(key);
        }
      }
    },
  };
}

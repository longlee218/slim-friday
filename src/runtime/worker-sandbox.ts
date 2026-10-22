import { type Dirent, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { SECRET_HOME } from "../config/sensitive-paths";
import type { GuardrailContext } from "../policy/check-tool-call";
import { isInside, realOrSame } from "../policy/paths";
import { findSensitive } from "./sensitive-files";

/* OS-level Bash sandbox of a dispatched worker (SDK `Options.sandbox`: Seatbelt on macOS, bubblewrap on Linux). This is the REAL
   boundary: the app does not parse the command line. A location the owner registered is
   trusted: inside a granted dir the worker's processes read and write everything (`.git` hooks and config, and for a location
   equal to the home dir the dotfiles, included). The sandbox bounds what is OUTSIDE the grants: no write outside them, no read of
   the agent home or of a credential dir that no grant covers. Network is open (owner decision). NOT live-verified (see the L2c checklist). */

/** Toolchain dirs of the home that a worker's `bun` / `cargo` / `node` needs to read (only those that exist are listed). Not secret. */
const TOOLCHAIN_HOME = [".bun", ".cargo", ".rustup", ".nvm", ".volta", ".deno", ".asdf", ".pyenv"];
/** Git's global config: readable (the commit identity lives there). */
const GIT_READ_HOME = [".gitconfig", ".config/git"];
/** Deepest a granted dir is split around a blocked entry. */
const CARVE_DEPTH = 4;

/**
 * `root` as a list of allowed read paths that leaves out every path of `blocked` inside it (an allow rule beats a deny rule, so a
 * granted home dir is listed child by child around the agent home). Fails closed: too deep or unreadable = nothing of it.
 */
export function carve(root: string, blocked: string[], depth = 0): string[] {
  if (!blocked.some((b) => b !== root && isInside(root, b))) return [root];
  if (depth >= CARVE_DEPTH) return [];
  let kids: Dirent[];
  try {
    kids = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return kids.flatMap((k) => {
    const p = join(root, k.name);
    if (blocked.some((b) => isInside(b, p))) return [];
    return k.isDirectory() ? carve(p, blocked, depth + 1) : [p];
  });
}

/**
 * The sandbox settings of a run: only a run WITH an envelope (a worker) gets one.
 * - Writes: only the run's write dirs and goal dir, and everything inside them.
 * - Reads: DENY BY DEFAULT for the owner's home (and `/Users`); the run's granted dirs, the toolchain dirs and git's global config
 *   are allowed back (an allow rule beats a deny rule, so a granted home is listed child by child around the agent home). A
 *   credential dir is denied only when no granted dir covers it: the location wins.
 * - Network OPEN (owner decision 2026-10-18; a command may also bind a localhost port): `allowedDomains: ["*"]` (bare wildcard, CLI >= 2.1.186). Without it the CLI keeps an
 *   empty allowlist and asks `canUseTool` (`SandboxNetworkAccess`) per host. The read/write limits above still bind. The sandbox is required and a command cannot opt out of it.
 */
export function workerSandbox(guard: GuardrailContext | undefined): Options["sandbox"] | undefined {
  const env = guard?.envelope;
  if (!guard || !env) return undefined;
  const allowWrite = [...new Set([...(guard.writePaths ?? []), env.goalDir])];
  const home = realOrSame(homedir());
  const homes = [...new Set([homedir(), home])];
  const grants = [...allowWrite, ...(guard.readPaths ?? []), ...(guard.cwd ? [guard.cwd] : [])].map(
    realOrSame,
  );
  // The agent home (every run) is carved out of a grant that contains it; a credential entry covered by a grant is dropped.
  const agentHome = (guard.denyPaths ?? []).map(realOrSame);
  const creds = homes
    .flatMap((h) => SECRET_HOME.map((n) => realOrSame(join(h, n))))
    .filter((c) => !grants.some((g) => isInside(g, c)));
  // The run's own dirs under a denied root (scratch, skills) come back whole; its pinned binaries are readable (so runnable).
  const inner = [
    ...(guard.allowInside ?? []),
    ...(guard.skillDirs ?? []),
    ...(guard.binaryPaths ?? []),
  ].map(realOrSame);
  const toolchain = homes
    .flatMap((h) => [...TOOLCHAIN_HOME, ...GIT_READ_HOME].map((n) => join(h, n)))
    .filter((p) => existsSync(p));
  // The SDK sandbox always lets a process write in its cwd. A run with no write grant covering the cwd (the scout) must not:
  // deny it explicitly (live probe 2026-10-16: without this a read-only worker could create and overwrite files in its cwd).
  const cwd = guard.cwd ? realOrSame(guard.cwd) : undefined;
  const writeGrants = allowWrite.map(realOrSame);
  // Sensitive files of the grants (.env, keys/...): neither readable nor writable, even inside a granted dir.
  const sensitive = [...new Set(grants.flatMap(findSensitive))];
  // `sensitive` also goes to denyWrite: the cwd is always writable for the SDK, so the carve of allowWrite alone would not cover it.
  const denyCwd = cwd && !writeGrants.some((w) => isInside(w, cwd)) ? [cwd] : [];
  // A write grant that contains the agent home (a `$HOME` location) must not reach it: deny it entry by entry, around the run's
  // own write dirs that sit inside it (scratch, goal dir).
  const denyAgentHome = agentHome
    .filter((a) => writeGrants.some((w) => isInside(w, a)))
    .flatMap((a) =>
      carve(
        a,
        writeGrants.filter((w) => w !== a && isInside(a, w)),
      ),
    );
  const denyWrite = [...new Set([...denyCwd, ...denyAgentHome, ...sensitive])];
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [...new Set(writeGrants.flatMap((w) => carve(w, sensitive)))],
      ...(denyWrite.length && { denyWrite }),
      denyRead: [
        ...new Set([
          ...agentHome,
          ...sensitive,
          ...creds,
          ...homes,
          ...(process.platform === "darwin" ? ["/Users"] : []),
        ]),
      ],
      allowRead: [
        ...new Set([
          ...grants.flatMap((g) => carve(g, [...agentHome, ...sensitive])),
          ...inner,
          ...toolchain,
        ]),
      ],
    },
    // Local binding: a dev or static server on localhost.
    network: { allowedDomains: ["*"], allowLocalBinding: true },
  };
}

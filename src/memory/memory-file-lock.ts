import {
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/** A lock older than this is stale even when its PID looks alive (crashed holder, PID reused). */
const STALE_MS = 10 * 60 * 1000;
/** An empty / unreadable lock younger than this is treated as live (its writer is mid-create). */
const EMPTY_GRACE_MS = 2000;
/** How long a writer waits for a busy lock before giving up. */
const WAIT_MS = 5000;
/** Pause between two lock attempts. */
const STEP_MS = 50;

/** Thrown when the lock of a memory file stayed busy for the whole wait: the write did NOT happen. */
export class MemoryBusyError extends Error {
  constructor(file: string) {
    super(`memory file busy: ${file}`);
    this.name = "MemoryBusyError";
  }
}

/** True when a process with this PID exists (EPERM = exists but not ours). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Counter that makes temp / reclaim file names unique inside one process. */
let seq = 0;
const uniqueSuffix = (): string => `${process.pid}.${Date.now()}.${seq++}`;

/**
 * A lock file is stale when its holder PID is gone or it is older than STALE_MS. An empty or unreadable body
 * younger than EMPTY_GRACE_MS counts as LIVE (never treat a half-seen lock as free); older = stale.
 */
function isStale(lock: string, now: number): boolean {
  try {
    const age = now - statSync(lock).mtimeMs;
    const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
    if (!Number.isInteger(pid) || pid <= 0) return age > EMPTY_GRACE_MS;
    return !pidAlive(pid) || age > STALE_MS;
  } catch {
    return false; // vanished meanwhile: the next attempt simply creates it
  }
}

/**
 * Create `<file>.lock` atomically WITH its content: write `<pid>` to a unique temp file in the same dir, then
 * `link` it to the lock name (fails with EEXIST when held), then drop the temp. The lock is never observable
 * empty. False when it exists.
 */
function tryCreate(lock: string): boolean {
  const tmp = `${lock}.${uniqueSuffix()}.tmp`;
  writeFileSync(tmp, String(process.pid), { mode: 0o600 });
  try {
    linkSync(tmp, lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Reclaim a stale lock so that two reclaimers cannot both win: rename it to a unique name (only one rename of
 * the same inode succeeds), re-check the renamed file, delete it if still stale, else put it back (it was
 * replaced by a live lock between our check and our rename).
 */
function reclaim(lock: string): void {
  const mine = `${lock}.stale.${uniqueSuffix()}`;
  try {
    renameSync(lock, mine);
  } catch {
    return; // someone else reclaimed or released it
  }
  if (isStale(mine, Date.now())) return void rmSync(mine, { force: true });
  try {
    linkSync(mine, lock); // restore the live lock we grabbed by mistake
  } catch {
    /* a newer lock exists already; the live holder's file is dropped below */
  }
  rmSync(mine, { force: true });
}

/** True when `file` exists and is a symlink. */
export function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Thrown when the memory file is a symlink: owner data is never written through a link. */
export class MemorySymlinkError extends Error {
  constructor(file: string) {
    super(`memory file is a symlink: ${file}`);
    this.name = "MemorySymlinkError";
  }
}

/** Options of `withMemoryLock` (tests shorten the wait). */
export interface LockOptions {
  waitMs?: number;
}

/**
 * Run `fn` while holding `<file>.lock` (one lock per memory file, used by every writer: agent appends,
 * pending appends, owner file writes). Stale locks are reclaimed (holder PID dead or lock older
 * than 10 min; an empty lock under 2 s old counts as live). Waits up to 5 s, then throws MemoryBusyError. The wait is
 * a synchronous sleep (blocks the event loop up to 5 s; writers are rare and the critical sections are tiny).
 * Refuses a symlinked memory file (MemorySymlinkError). Released in `finally`. `fn` must be synchronous
 * and short (never an LLM call).
 */
export function withMemoryLock<T>(file: string, fn: () => T, opts: LockOptions = {}): T {
  if (isSymlink(file)) throw new MemorySymlinkError(file);
  const lock = `${file}.lock`;
  const deadline = Date.now() + (opts.waitMs ?? WAIT_MS);
  while (!tryCreate(lock)) {
    if (isStale(lock, Date.now())) {
      reclaim(lock);
      continue;
    }
    if (Date.now() >= deadline) throw new MemoryBusyError(file);
    Bun.sleepSync(STEP_MS);
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/** Write `text` to `file` through `<file>.tmp` + rename, so a reader never sees a half-written file. */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

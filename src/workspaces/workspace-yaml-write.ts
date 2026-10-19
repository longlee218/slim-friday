import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { workspacePaths } from "../config/workspace-paths";
import { backupPersonaFile } from "../discord-setup/persona-backup";
import { withMemoryLock } from "../memory/memory-file-lock";

/** A `channels:` entry as written in workspace.yaml: an object with `id`. */
export type ChannelEntry = { id: string } & Record<string, unknown>;

/**
 * The raw `channels:` entries. An unquoted 17-20 digit id is parsed by YAML as a lossy number: never map it to
 * a (wrong) string, throw instead so the workspace is treated as not safe to touch.
 */
export function channelEntries(value: unknown): ChannelEntry[] {
  if (value === undefined || value === null) return [];
  const ok = (c: unknown) =>
    typeof c === "object" && c !== null && typeof (c as { id?: unknown }).id === "string";
  if (!Array.isArray(value) || !value.every(ok))
    throw new Error("workspace.yaml channels must be objects with a string id");
  return value as ChannelEntry[];
}

/** Write `text` to `file` through a unique temp file (`wx`, 0600, never follows a pre-planted file) + rename. */
function writeYamlAtomic(file: string, text: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true }); // never leave a half-written temp behind
    throw err;
  }
}

/** Options of `updateWorkspaceYaml`. */
export interface UpdateOptions {
  /** When set, the old bytes are copied to the persona backup folder (keep 10) before the write. */
  backupAt?: Date;
  /** Runs after the rename; a returned reason makes the writer restore the old bytes and refuse. */
  verify?: () => string | undefined;
  /** Lock wait in ms (default: the lock's own 5 s; tests shorten it). */
  waitMs?: number;
}

/**
 * The ONE writer of `workspace.yaml`: lock (`workspace.yaml.lock`, shared by /init-channel, auto-adopt and Orchestrate register_location)
 * -> parse -> `mutate(data)` -> stringify -> temp + rename 0600. `mutate` edits the parsed object in place; a returned
 * string refuses WITHOUT writing, a throw aborts (lock released). The file is re-rendered deterministically, so comments in
 * it are lost (the backup keeps the old bytes). Returns the refusal reason, or undefined when the file was written.
 * Throws MemoryBusyError when the lock stays busy.
 */
export function updateWorkspaceYaml(
  home: string,
  space: string,
  mutate: (data: Record<string, unknown>) => string | undefined,
  opts: UpdateOptions = {},
): string | undefined {
  const { config } = workspacePaths(home).workspace(space);
  return withMemoryLock(
    config,
    () => {
      const old = readFileSync(config);
      const data = (Bun.YAML.parse(old.toString("utf8")) ?? {}) as Record<string, unknown>;
      const refusal = mutate(data);
      if (refusal) return refusal;
      if (opts.backupAt)
        backupPersonaFile(home, { space, file: "workspace.yaml" }, old, opts.backupAt);
      writeYamlAtomic(config, Bun.YAML.stringify(data, null, 2));
      // From here the new file is live: unless verify passes (and does not throw), the old bytes go back.
      let bad: string | undefined = "verification did not complete";
      try {
        bad = opts.verify?.();
      } finally {
        if (bad) writeYamlAtomic(config, old);
      }
      return bad;
    },
    { waitMs: opts.waitMs },
  );
}

/** Append `entry` to the raw `locations:` list (created when absent). */
export function addLocationEntry(
  data: Record<string, unknown>,
  entry: { name: string; path: string; description: string },
): void {
  const list = Array.isArray(data.locations) ? data.locations : [];
  list.push(entry);
  data.locations = list;
}

/**
 * Let channel `channelId` use location `name`. An absent `locations` means every location of the space (nothing to add);
 * a list (`[]` = explicit none included) gets the name appended once. Returns a refusal when the channel is not in the space.
 */
export function linkChannelLocation(
  data: Record<string, unknown>,
  channelId: string,
  name: string,
): string | undefined {
  const channel = channelEntries(data.channels).find((c) => c.id === channelId);
  if (!channel) return "channel is not mapped in this space";
  if (Array.isArray(channel.locations) && !channel.locations.includes(name))
    channel.locations.push(name);
  return undefined;
}

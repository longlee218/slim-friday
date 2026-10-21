import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOCATION_NAME, workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import type { Workspace, WorkspaceChannel } from "../workspaces/workspace-registry";
import { listWorkspaces } from "./index/memory-files";
import {
  MemoryBusyError,
  MemorySymlinkError,
  withMemoryLock,
  writeAtomic,
} from "./memory-file-lock";
import { isMigrated, markMigrated } from "./memory-migration-marker";
import {
  hasBullet,
  insertBullet,
  KIND_HEADING,
  MEMORY_FILE_KINDS,
  type MemoryKind,
} from "./memory-sections";
import { channelTarget } from "./memory-targets";

/** Marker step of this migration. */
export const LAYERS_V2_STEP = "layers-v2";

const log = logger.child({ module: "memory-layer-migration" });

/** What a legacy memory file holds that can move: kind bullets (line kept as written) and verbatim blocks. */
interface Legacy {
  bullets: { kind: MemoryKind; line: string }[];
  /** Non-kind content: owner `## topic` sections and prose inside a kind section, each as verbatim text. */
  blocks: string[];
}

/** Counts of one run (the `memory.migrate` log line). `failed` > 0 = the marker is NOT written, the next start retries. */
export interface MigrationResult {
  channels: number;
  bullets: number;
  sections: number;
  orphans: number;
  failed: number;
}

/**
 * Split a legacy MEMORY.md into movable parts. The part before the first `## ` is the template header: not merged.
 * A file without any `## ` entry (template only) gives null.
 */
export function parseLegacy(text: string): Legacy | null {
  const sections: { heading: string; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) sections.push({ heading: line, lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  if (!sections.length) return null;
  const out: Legacy = { bullets: [], blocks: [] };
  for (const s of sections) {
    const kind = MEMORY_FILE_KINDS.find((k) => s.heading === `## ${KIND_HEADING[k]}`);
    // A kind section moves bullet by bullet (same section of the channel file); any other line is kept as prose.
    const bullets = kind ? s.lines.filter((l) => l.trim().startsWith("- ")) : [];
    for (const l of bullets) if (kind) out.bullets.push({ kind, line: l.trim() });
    const rest = kind ? s.lines.filter((l) => l.trim() !== "" && !bullets.includes(l)) : s.lines;
    const heading = kind ? `${s.heading} (prose)` : s.heading;
    if (rest.some((l) => l.trim() !== ""))
      out.blocks.push([heading, ...trimEndBlank(rest)].join("\n"));
  }
  return out;
}

/** Drop trailing blank lines (the lines before stay as written). */
function trimEndBlank(lines: string[]): string[] {
  let b = lines.length;
  while (b > 0 && (lines[b - 1] ?? "").trim() === "") b--;
  return lines.slice(0, b);
}

/** Text of a regular (non-symlink) file, or "" when it is missing, a link or unreadable. */
function readLegacyFile(file: string): string {
  try {
    if (!lstatSync(file).isFile()) return "";
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Merge one legacy file into one channel file under the lock: bullets go to their kind section unless the section
 * already has the note (original date kept); blocks go to the end under `## From <label> memory` unless the exact
 * block is already in the file. Writes only when the text changed.
 */
function mergeInto(
  file: string,
  template: string,
  legacy: Legacy,
  label: string,
): { bullets: number; sections: number; changed: boolean } {
  // A channel dir that does not exist yet (channel added after ensureHome) is created before the lock file.
  mkdirSync(dirname(file), { recursive: true });
  return withMemoryLock(file, () => {
    const old = existsSync(file) ? readFileSync(file, "utf8") : template;
    let text = old;
    let bullets = 0;
    for (const b of legacy.bullets) {
      if (hasBullet(text, b.kind, b.line)) continue;
      text = insertBullet(text, b.kind, b.line);
      bullets++;
    }
    const fresh = legacy.blocks.filter((b) => !text.includes(b));
    if (fresh.length) {
      const heading = `## From ${label} memory`;
      const head = text.split("\n").some((l) => l.trimEnd() === heading) ? [] : [heading];
      text = `${text.trimEnd()}\n\n${[...head, ...fresh].join("\n\n")}\n`;
    }
    const changed = text !== old || !existsSync(file);
    if (changed) {
      writeAtomic(file, text);
    }
    return { bullets, sections: fresh.length, changed };
  });
}

/** Channels of `ws` that include location `loc` (a channel with no `locations` key has every location). */
const channelsOf = (ws: Workspace, loc: string): WorkspaceChannel[] =>
  ws.channelDefs.filter((c) => !c.locations || c.locations.includes(loc));

/** Directory names under `<ws>/locations/` that are valid location names, sorted. */
function legacyLocationDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => LOCATION_NAME.test(n))
      .sort();
  } catch {
    return [];
  }
}

/**
 * One-time merge of the retired memory layers into the channel files (step `layers-v2`).
 * - workspace `MEMORY.md` -> every channel of the space;
 * - location `MEMORY.md` of L -> every channel that includes L;
 * - a space or location with content but no channel to take it is an orphan (counted, left alone);
 * - the pending queue is never merged (review queue, never injected); every old file stays on disk, untouched.
 * Idempotent (dedupe), counts-only log `memory.migrate`; the marker is written LAST and only when nothing failed.
 */
export function migrateMemoryLayers(home: string, workspaces: Workspace[]): MigrationResult {
  const out: MigrationResult = { channels: 0, bullets: 0, sections: 0, orphans: 0, failed: 0 };
  if (isMigrated(home, LAYERS_V2_STEP)) return out;
  const touched = new Set<string>();
  /**
   * Merge `file` into each of `targets`; no target (or no content) is an orphan only when there was content.
   * `unloaded` = the space has no loaded workspace entry (its channels are unknown): content counts as failed so
   * the next start retries, never as an orphan.
   */
  const move = (
    ws: string,
    file: string,
    label: string,
    targets: WorkspaceChannel[],
    unloaded: boolean,
  ) => {
    const legacy = parseLegacy(readLegacyFile(file));
    if (!legacy) return;
    if (unloaded) {
      out.failed++;
      logEvent(
        log,
        "memory.migrate.skipped",
        { workspace: ws, reason: "workspace not loaded" },
        "warn",
      );
      return;
    }
    if (!targets.length) {
      out.orphans++;
      return;
    }
    for (const c of targets) {
      const t = channelTarget(home, ws, c.name);
      try {
        const r = mergeInto(t.file, t.template, legacy, label);
        out.bullets += r.bullets;
        out.sections += r.sections;
        if (r.changed) touched.add(t.file);
      } catch (err) {
        if (!(err instanceof MemoryBusyError || err instanceof MemorySymlinkError)) throw err;
        out.failed++;
        logEvent(log, "memory.migrate.skipped", { workspace: ws, reason: err.name }, "warn");
      }
    }
  };
  for (const name of listWorkspaces(home)) {
    const ws = workspaces.find((w) => w.name === name);
    const paths = workspacePaths(home).workspace(name);
    const channels = ws?.channelDefs ?? [];
    move(name, join(paths.root, "MEMORY.md"), "workspace", channels, !ws);
    for (const loc of legacyLocationDirs(paths.locations)) {
      // A location dir that the space no longer lists belongs to no channel.
      const known = ws?.locations.some((l) => l.name === loc);
      move(
        name,
        join(paths.locations, loc, "MEMORY.md"),
        `location ${loc}`,
        known && ws ? channelsOf(ws, loc) : [],
        !ws,
      );
    }
  }
  out.channels = touched.size;
  logEvent(log, "memory.migrate", {
    step: LAYERS_V2_STEP,
    channels: out.channels,
    bullets: out.bullets,
    sections: out.sections,
    orphans: out.orphans,
    failed: out.failed,
  });
  if (out.failed === 0) markMigrated(home, LAYERS_V2_STEP);
  return out;
}

import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type FileConfig, parseSettingsFile } from "@friday/config";
import { AdminError, type PermissionsAdmin } from "@friday/core";

/** A top-level `permissions:` line in block form (the value on the next, indented lines). */
const BLOCK_HEAD = /^permissions:\s*(#.*)?$/;
/** Any top-level `permissions` key (block or flow form). */
const ANY_HEAD = /^permissions\s*:/;
/** An `autoReview:` line inside the block. */
const AUTO_REVIEW_LINE = /^(\s+)autoReview\s*:.*$/;

/**
 * `settings.yaml` text with `permissions.autoReview` set to `on`: the existing line is replaced, or one is added under
 * `permissions:`, or a `permissions:` block is appended. Every other line (comments included) stays, and a CRLF file
 * stays CRLF (lines are matched without their `\r`). A flow-form `permissions: {...}` is refused (edited by hand).
 */
export function withAutoReview(text: string, on: boolean): string {
  const cr = text.includes("\r\n") ? "\r" : "";
  const lines = text.split("\n");
  /** A line without its trailing `\r`, for matching. */
  const bare = (l: string | undefined) => (l ?? "").replace(/\r$/, "");
  const head = lines.findIndex((l) => BLOCK_HEAD.test(bare(l)));
  if (head < 0) {
    if (lines.some((l) => ANY_HEAD.test(bare(l))))
      throw new AdminError(
        "BAD_REQUEST",
        "settings.yaml has permissions in a form to edit by hand",
      );
    const body = text === "" || text.endsWith("\n") ? text : `${text}${cr}\n`;
    return `${body}permissions:${cr}\n  autoReview: ${on}${cr}\n`;
  }
  // The block: the lines after the head that are indented, blank or comments.
  for (let i = head + 1; i < lines.length && /^(\s|#|$)/.test(bare(lines[i])); i++) {
    const m = AUTO_REVIEW_LINE.exec(bare(lines[i]));
    if (m) {
      lines[i] = `${m[1]}autoReview: ${on}${lines[i]?.endsWith("\r") ? "\r" : ""}`;
      return lines.join("\n");
    }
  }
  lines.splice(head + 1, 0, `  autoReview: ${on}${cr}`);
  return lines.join("\n");
}

/**
 * The permission switches behind the web API: read from the live config, written to `<AGENT_HOME>/config/settings.yaml`
 * (atomically, never through a symlink, checked by the same parser that loads it). The config watcher reloads it, and
 * the permission gate reads the settings at every call, so the switch applies without a restart.
 */
export function createPermissionsAdmin(config: FileConfig, agentHome: string): PermissionsAdmin {
  const file = join(agentHome, "config", "settings.yaml");
  return {
    get: () => ({ autoReview: config.settings().autoReview === true }),
    setAutoReview(on) {
      // lstat, not exists: a dangling link must be refused too.
      if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
        throw new AdminError("BAD_REQUEST", "settings.yaml is a symlink");
      const next = withAutoReview(existsSync(file) ? readFileSync(file, "utf8") : "", on);
      let parsed: ReturnType<typeof parseSettingsFile>;
      try {
        parsed = parseSettingsFile(next);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new AdminError("BAD_REQUEST", `settings.yaml would not load: ${why}`);
      }
      if (parsed.permissions?.autoReview !== on)
        throw new AdminError(
          "BAD_REQUEST",
          "settings.yaml has permissions in a form to edit by hand",
        );
      // The new file keeps the old one's mode (a 0600 settings.yaml stays 0600).
      const mode = existsSync(file) ? statSync(file).mode & 0o7777 : undefined;
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, next, mode === undefined ? undefined : { mode });
      if (mode !== undefined) chmodSync(tmp, mode);
      renameSync(tmp, file);
    },
  };
}

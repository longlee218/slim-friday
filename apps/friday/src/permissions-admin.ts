import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 * `permissions:`, or a `permissions:` block is appended. Every other line (comments included) stays. A flow-form
 * `permissions: {...}` is refused (it is edited by hand).
 */
export function withAutoReview(text: string, on: boolean): string {
  const lines = text.split("\n");
  const head = lines.findIndex((l) => BLOCK_HEAD.test(l));
  if (head < 0) {
    if (lines.some((l) => ANY_HEAD.test(l)))
      throw new AdminError(
        "BAD_REQUEST",
        "settings.yaml has permissions in a form to edit by hand",
      );
    const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}permissions:\n  autoReview: ${on}\n`;
  }
  // The block: the lines after the head that are indented, blank or comments.
  for (let i = head + 1; i < lines.length && /^(\s|#|$)/.test(lines[i] ?? ""); i++) {
    const m = AUTO_REVIEW_LINE.exec(lines[i] ?? "");
    if (m) {
      lines[i] = `${m[1]}autoReview: ${on}`;
      return lines.join("\n");
    }
  }
  lines.splice(head + 1, 0, `  autoReview: ${on}`);
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
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, next);
      renameSync(tmp, file);
    },
  };
}

import { readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { ARTIFACT_KINDS } from "../../artifacts/artifact-kinds";
import { REPORT_REPO_DOC_MAX_BYTES } from "../../artifacts/artifact-limits";
import { pathSegment, writeFileExclusive } from "../../artifacts/safe-write";
import { REPORT_FILE_MAX_BYTES } from "../../config/message-caps";
import { errText } from "../../observability/redact";
import { isHiddenByAgentHome, isInside } from "../../policy/paths";
import { isSensitivePath } from "../../runtime/sensitive-files";

/* `Report result` `files`: the deliverables a worker names. Checked at report time with the screenshot checks (real path
   inside the base, not sensitive, a regular file); nothing is registered as an artifact: `forward` makes those. A file in
   the scratch dir is copied (the scratch dir is swept after days), a file of the granted location stays a reference. */

/** One checked deliverable, as stored on the result message. */
export interface ReportFile {
  title: string;
  /** `location`: a path relative to the granted location; `scratch`: the absolute path of the copy under `task-files`. */
  base: "location" | "scratch";
  /** Name of the granted location (`base` location only). */
  location?: string;
  path: string;
}

/** What the check needs from the run. */
export interface ReportFilesCtx {
  /** AGENT_HOME. */
  home: string;
  /** Destination of scratch copies: `<home>/task-files/<goalId>/<taskId>/<turnId>`. */
  copyDir: string;
  /** The run's scratch dir (the base when the run has no granted location). */
  scratchDir?: string | undefined;
  /** The run's granted location (the base when the run has one). */
  granted?: { name: string; path: string } | undefined;
}

/** Extension of a path as an artifact kind, or undefined for anything else (code is not a document). */
const kindOf = (path: string): string | undefined => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (ARTIFACT_KINDS as readonly string[]).includes(ext) ? ext : undefined;
};

/**
 * Check the files a report names and copy the scratch ones. Returns the entries to store, or one error per refused entry
 * (the report is then NOT stored and no copy is left behind: the worker fixes it).
 */
export function checkReportFiles(
  files: { title: string; path: string }[],
  ctx: ReportFilesCtx,
): { files: ReportFile[] } | { errors: string[] } {
  const errors: string[] = [];
  const out: ReportFile[] = [];
  const copies: string[] = [];
  const baseDir = ctx.granted?.path ?? ctx.scratchDir;
  files.forEach((f, i) => {
    try {
      if (!baseDir) throw new Error("this run has no location or scratch dir for a file");
      if (isAbsolute(f.path))
        throw new Error("the path must be relative to your location or scratch dir");
      const root = realpathSync(baseDir);
      const real = realpathSync(resolve(root, f.path));
      if (!isInside(root, real)) throw new Error("not inside the location or scratch dir");
      if (isHiddenByAgentHome(ctx.home, root, real)) throw new Error("inside AGENT_HOME");
      if (isSensitivePath(f.path) || isSensitivePath(relative(root, real)))
        throw new Error("a sensitive file");
      if (!kindOf(real))
        throw new Error(
          `a file is a document (${ARTIFACT_KINDS.join(", ")}); code files are not deliverables: describe them in the summary`,
        );
      const st = statSync(real);
      if (!st.isFile()) throw new Error("not a file");
      const cap = ctx.granted ? REPORT_REPO_DOC_MAX_BYTES : REPORT_FILE_MAX_BYTES;
      if (st.size > cap) throw new Error(`over ${cap} bytes`);
      if (ctx.granted) {
        out.push({
          title: f.title,
          base: "location",
          location: ctx.granted.name,
          path: relative(root, real),
        });
        return;
      }
      // A scratch file is copied now, before the sweeper can take the original.
      const copy = writeFileExclusive(
        ctx.home,
        ctx.copyDir,
        `${i + 1}-${pathSegment(basename(real))}`,
        readFileSync(real, "utf8"),
      );
      if (!copy) throw new Error("copy name taken");
      copies.push(copy);
      out.push({ title: f.title, base: "scratch", path: copy });
    } catch (err) {
      errors.push(`files[${i}] ${f.path}: ${errText(err, 120)}`);
    }
  });
  if (errors.length) {
    for (const c of copies) rmSync(c, { force: true }); // a refused report leaves no copy
    return { errors };
  }
  return { files: out };
}

import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Refused } from "../design/design-util";
import { CLONE_GIT_ARGS, CLONE_TIMEOUT_MS, cloneEnv } from "../skills/clone-skill-source";
import { defaultGitRunner } from "../skills/git-runner";
import { removeDir } from "./skill-lookups";

/**
 * `git ls-remote <url> HEAD` with the same hardened args and env as a clone, in a throwaway HOME under `lookupDir`.
 * The caller passes a URL that `parseSkillSource` already accepted; `--` keeps it from being read as an option.
 */
export async function lsRemoteHead(
  url: string,
  lookupDir: string,
  pathEnv: string,
): Promise<string> {
  mkdirSync(lookupDir, { recursive: true });
  const tmp = mkdtempSync(join(lookupDir, "clone-ls-"));
  try {
    const r = await defaultGitRunner(
      ["git", ...CLONE_GIT_ARGS, "ls-remote", "--", url, "HEAD"],
      cloneEnv(tmp, pathEnv),
      CLONE_TIMEOUT_MS,
    );
    if (r.code !== 0) throw new Refused("git could not reach the source.", "source");
    return r.out;
  } finally {
    removeDir(tmp);
  }
}

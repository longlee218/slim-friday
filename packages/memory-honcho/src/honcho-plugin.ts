import type { MemoryProviderPlugin } from "@friday/core";
import { honchoId } from "./honcho-client";
import { HONCHO_DEFAULT_WORKSPACE, HONCHO_SOURCE_ID, honchoSource } from "./honcho-source";
import { checkHonchoUrl, isPrivateHonchoUrl } from "./honcho-url";

/** Env name of the Honcho key (on the child-env deny list by its `HONCHO_` prefix). */
export const HONCHO_API_KEY_ENV = "HONCHO_API_KEY";

/** Options of a `memory.providers` entry with `id: honcho`. */
export interface HonchoOptions {
  baseUrl: string;
  workspace: string;
}

/** Keys an entry may have besides `id`. */
const KEYS = new Set(["baseUrl", "workspace"]);

/** The Honcho memory provider plugin. */
export const honchoPlugin: MemoryProviderPlugin<HonchoOptions> = {
  id: HONCHO_SOURCE_ID,
  secretEnv: [HONCHO_API_KEY_ENV],
  parseOptions(raw) {
    const extra = Object.keys(raw).filter((k) => !KEYS.has(k));
    if (extra.length) throw new Error(`honcho: unknown option ${extra.join(", ")}`);
    if (typeof raw.baseUrl !== "string" || !raw.baseUrl)
      throw new Error("honcho: baseUrl is required");
    const workspace = raw.workspace ?? HONCHO_DEFAULT_WORKSPACE;
    if (typeof workspace !== "string" || honchoId(workspace) !== workspace || !workspace)
      throw new Error("honcho: workspace may use letters, digits, _ and - only");
    return { baseUrl: raw.baseUrl, workspace };
  },
  check(o, secrets) {
    const bad = checkHonchoUrl(o.baseUrl);
    if (bad) return [`honcho: ${bad}`];
    if (!isPrivateHonchoUrl(o.baseUrl) && !secrets[HONCHO_API_KEY_ENV])
      return [
        `honcho: ${HONCHO_API_KEY_ENV} is needed for a Honcho outside this machine or network`,
      ];
    return [];
  },
  create(o, secrets, deps) {
    const apiKey = secrets[HONCHO_API_KEY_ENV];
    return honchoSource(
      { baseUrl: o.baseUrl, ...(apiKey && { apiKey }), ...(deps.fetch && { fetch: deps.fetch }) },
      { workspace: o.workspace },
    );
  },
};

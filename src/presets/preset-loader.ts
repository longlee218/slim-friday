import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU_MODEL, OPUS_MODEL, SONNET_MODEL } from "../config/model-ids";
import { MAX_FIX_LOOPS, STALE_AFTER_MS } from "../config/resilience-caps";
import type { RoleDefinition } from "../roles/role-types";
import * as sdkToolNames from "../tools/sdk-tool-names";
import { TOOL_CATALOG } from "../tools/tool-catalog-entries";
import { type Preset, presetSchema } from "./preset-schema";
import { type PromptView, renderPrompt } from "./prompt-template";

/* Roles as files: `config/presets/<role>/{preset.yaml,prompt.md}` and `config/presets/_partials/<name>.md`, read once at
   start. They ship with the repo (reviewed in git); nothing outside the repo overrides them. */

const MODEL_IDS = { haiku: HAIKU_MODEL, sonnet: SONNET_MODEL, opus: OPUS_MODEL } as const;

/** Tool names a prompt may use as `{{tool.<name>}}`: every catalog tool and every SDK built-in tool name. */
const TOOL_NAMES: Record<string, string> = Object.fromEntries(
  [
    ...TOOL_CATALOG.map((d) => d.id),
    ...(Object.values(sdkToolNames) as unknown[]).filter((v): v is string => typeof v === "string"),
  ].map((n) => [n, n]),
);

/** The view of one preset's prompt. */
const viewOf = (p: Preset): PromptView => ({
  tool: TOOL_NAMES,
  limit: {
    maxTurns: p.limits.maxTurns,
    subagentsParallel: p.subagents.parallel,
    maxFixLoops: MAX_FIX_LOOPS,
    staleMinutes: STALE_AFTER_MS / 60_000,
  },
  vars: p.vars ?? {},
});

/** Partials of the folder `_partials` (`<name>.md`, the text without its closing newline). */
function loadPartials(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")))
    out[f.replace(/\.md$/, "")] = readFileSync(join(dir, f), "utf8").replace(/\n$/, "");
  return out;
}

/** Load one role folder; throws naming the file and the problem. */
function loadRole(dir: string, folder: string, partials: Record<string, string>): RoleDefinition {
  const file = join(dir, folder, "preset.yaml");
  const parsed = presetSchema.safeParse(Bun.YAML.parse(readFileSync(file, "utf8")));
  if (!parsed.success)
    throw new Error(
      `${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
    );
  const { vars: _vars, model, ...role } = parsed.data;
  if (role.name !== folder) throw new Error(`${file}: name "${role.name}" must equal its folder`);
  const promptFile = join(dir, folder, "prompt.md");
  const template = readFileSync(promptFile, "utf8").replace(/\n$/, "");
  const text = renderPrompt(promptFile, template, viewOf(parsed.data), partials);
  return { ...role, model: MODEL_IDS[model], promptSections: () => [text] };
}

/** Every role under `dir`, by name; the first invalid file throws. Folders starting with `_` are not roles. */
export function loadPresets(dir: string): Record<string, RoleDefinition> {
  const partials = loadPartials(join(dir, "_partials"));
  const roles: Record<string, RoleDefinition> = {};
  for (const folder of readdirSync(dir, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.name.startsWith("_")) continue;
    roles[folder.name] = loadRole(dir, folder.name, partials);
  }
  return roles;
}

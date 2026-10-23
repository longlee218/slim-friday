import { z } from "zod";
import { TOOL_BY_ID } from "../tools/tool-catalog-entries";

/* The shape of `config/presets/<role>/preset.yaml`: the data fields of a `RoleDefinition` (the prompt is `prompt.md`). */

/** Model aliases a preset may name; `config/model-ids.ts` holds the ids. */
export const MODEL_ALIASES = ["haiku", "sonnet", "opus"] as const;

const names = z.array(z.string().min(1));

/** A bare MCP tool name that exists in the tool catalog (a typo refuses the start). */
const mcpTool = z.string().refine((id) => TOOL_BY_ID.has(id), { message: "unknown tool id" });

export const presetSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    whenToUse: z.string().min(1),
    notFor: z.string().min(1).optional(),
    kind: z.enum(["teammate", "worker"]),
    skills: names.optional(),
    preloadSkills: names.optional(),
    requiredSkills: names.optional(),
    noSubagents: z.boolean().optional(),
    subagents: z
      .object({ parallel: z.number().int().min(1), depth: z.number().int().min(1) })
      .strict(),
    dispatchable: z.boolean().optional(),
    mcpTools: z.array(mcpTool).optional(),
    limits: z
      .object({ maxAsk: z.number().int().min(0), maxTurns: z.number().int().min(1) })
      .strict(),
    model: z.enum(MODEL_ALIASES),
    thinking: z
      .object({ type: z.enum(["adaptive", "disabled"]) })
      .strict()
      .optional(),
    budgetUsd: z.number().positive(),
    streaming: z.boolean().optional(),
    permissionMode: z.enum(["auto", "bypassPermissions"]).optional(),
    sideEffects: z.enum(["none", "location", "external"]),
    basePrompt: z.literal("custom").optional(),
    capabilities: z.array(
      z.enum([
        "read",
        "write",
        "shell",
        "web",
        "skills",
        "subagents",
        "tasks",
        "mcp",
        "review",
        "feedback",
        "ask",
      ]),
    ),
    binaries: names.optional(),
    /** Text variables of the prompt (`{{vars.<key>}}`). */
    vars: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type Preset = z.infer<typeof presetSchema>;

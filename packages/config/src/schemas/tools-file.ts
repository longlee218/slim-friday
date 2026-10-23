import type { ToolSpec } from "@friday/core";
import { z } from "zod";

/** The content of `tools.yaml`: tool annotations (what the permission decision reads). */
const toolsSchema = z.strictObject({
  tools: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        annotations: z
          .strictObject({
            readOnlyHint: z.boolean().optional(),
            destructiveHint: z.boolean().optional(),
            idempotentHint: z.boolean().optional(),
            openWorldHint: z.boolean().optional(),
          })
          .optional(),
        sandboxed: z.boolean().optional(),
        scopeKeys: z.array(z.string().min(1)).optional(),
      }),
    )
    .refine((t) => new Set(t.map((x) => x.name)).size === t.length, "duplicate tool name"),
});

/** Parse `tools.yaml` into tool specs. Throws a readable error for any problem. */
export function parseToolsFile(text: string): ToolSpec[] {
  return toolsSchema.parse(Bun.YAML.parse(text)).tools;
}

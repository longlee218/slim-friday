import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runTool, toToolResult } from "../tool-result";
import { describeActions, paramHint } from "./action-hint";
import type { AnyAction } from "./action-types";
import { BAD_ACTION, BAD_PARAMS } from "./constants";

/** Input of every action tool: the action name and a loose params object (checked per action in the handler). */
const paramsOf = (names: [string, ...string[]]) => ({
  action: z.enum(names),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Builds ONE MCP tool from an action table. The model sees `{ action, params }` and a one-line-per-action
 * description; the params schema of each action stays out of the tool definition (a union would put every schema back
 * and defeat the point). The handler checks `params` against the action's own schema: a failure is `BAD_PARAMS`
 * with that action's params and one example, an unknown action is `BAD_ACTION` with the action list.
 * The table is the only thing a tool adds: a new action = a new table row.
 */
export function createActionTool<C>(opts: {
  /** Tool name (from the tool's `constants.ts`). */
  name: string;
  /** One short line before the action list. */
  intro: string;
  ctx: C;
  actions: readonly AnyAction<C>[];
}) {
  const { name, ctx, actions } = opts;
  const byName = new Map(actions.map((a) => [a.name, a]));
  const names = actions.map((a) => a.name) as [string, ...string[]];
  return tool(
    name,
    describeActions(opts.intro, actions as readonly AnyAction<unknown>[]),
    paramsOf(names),
    async (args) => {
      const action = byName.get(args.action);
      // The enum already refuses an unknown name at the SDK; this guards a direct call and keeps the contract.
      if (!action)
        return toToolResult({
          ok: false,
          code: BAD_ACTION,
          message: `Unknown action "${args.action}". Actions: ${names.join(", ")}.`,
        });
      const parsed = action.schema.safeParse(args.params ?? {});
      if (!parsed.success)
        return toToolResult({
          ok: false,
          code: BAD_PARAMS,
          message:
            `Bad params for "${action.name}": ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "params"}: ${i.message}`)
              .join("; ")}. ` +
            `Params: ${paramHint(action as AnyAction<unknown>) || "(none)"}. ` +
            `Example: ${JSON.stringify({ action: action.name, params: action.example })}`,
        });
      return runTool(`${name}.${action.name}`, async () => action.run(ctx, parsed.data));
    },
  );
}

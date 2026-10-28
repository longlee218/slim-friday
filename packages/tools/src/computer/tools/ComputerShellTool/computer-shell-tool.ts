import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { ComputerSession } from "../../computer-session";
import { COMPUTER_SHELL_TOOL, SHELL_DEFAULT_TIMEOUT_MS, SHELL_MAX_TIMEOUT_MS } from "./constants";
import { COMPUTER_SHELL_DESCRIPTION } from "./prompt";

/** Input the model sees (the timeout limit is checked in the handler, so the refusal is readable). */
const SHAPE = {
  command: z.array(z.string().min(1)).min(1).describe("argv: program then arguments."),
  timeoutMs: z.number().finite().positive().optional().describe("Defaults to 30000."),
};

/** `ComputerShell` for one session. */
export function createComputerShellTool(s: ComputerSession) {
  return tool(
    COMPUTER_SHELL_TOOL,
    COMPUTER_SHELL_DESCRIPTION,
    SHAPE,
    (async ({ command, timeoutMs }: { command: string[]; timeoutMs?: number }) => {
      if (command.length === 0 || command.some((c) => c === "")) {
        return textResult("command must be a non-empty list of non-empty strings.", true);
      }
      const timeout = timeoutMs ?? SHELL_DEFAULT_TIMEOUT_MS;
      if (!(timeout > 0) || timeout > SHELL_MAX_TIMEOUT_MS) {
        return textResult(`timeoutMs must be between 1 and ${SHELL_MAX_TIMEOUT_MS}.`, true);
      }
      return s.run(async () => {
        const r = await s.ctx.provider.exec(s.ctx.computer.name, command, timeout);
        return textResult(`exit code ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
      });
    }) as never,
    { annotations: { openWorldHint: true } },
  );
}

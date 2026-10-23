import { expect, test } from "bun:test";
import { mcpToolNamesOfRole } from "../src/mcp/tool-names-of-role";
import { isWriterRole } from "../src/orchestrator/plan/verify-items";
import { guardFor } from "../src/policy/check-tool-call";
import { mayHaveWritten } from "../src/roles/capability-registry";
import { countsTowardCap, ROLES } from "../src/roles/role-registry";
import { subagentToolsFor, toolOptions, toolsFor } from "../src/tools/tool-catalog";

/* Golden of the tool policy of every role: the SDK tool options, the guard's lists and the writer / cap flags. The
   catalog + derived-policy refactor (phase 01) must leave it byte-identical. */

test("tool policy of every role is unchanged", () => {
  const snap = Object.fromEntries(
    Object.values(ROLES)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => {
        const g = guardFor(r, {} as never);
        return [
          r.name,
          {
            toolOptions: toolOptions(r),
            toolsFor: toolsFor(r),
            subagentToolsFor: subagentToolsFor(r),
            guard: {
              allowTools: g.allowTools,
              shell: g.shell,
              subagentTools: g.subagentTools,
              subagents: g.subagents,
            },
            mcpToolNames: mcpToolNamesOfRole(r),
            mayHaveWritten: mayHaveWritten(r),
            isWriterRole: isWriterRole(r),
            countsTowardCap: countsTowardCap(r),
          },
        ];
      }),
  );
  expect(snap).toMatchSnapshot();
});

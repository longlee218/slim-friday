import { expect, test } from "bun:test";
import { SAVE_ARTIFACT_TOOL } from "../src/mcp/artifacts/tools/SaveArtifactTool/constants";
import { ROLES } from "../src/roles/role-registry";

/* Only the lead makes artifacts: no other role lists SaveArtifact (workers send files through Report result). */

test("no role except the lead lists SaveArtifact; every role keeps the read tools", () => {
  for (const role of Object.values(ROLES))
    expect([role.name, role.mcpTools?.includes(SAVE_ARTIFACT_TOOL) ?? false]).toEqual([
      role.name,
      role.name === "lead",
    ]);
  expect(ROLES.developer?.mcpTools).toContain("ReadArtifact");
});

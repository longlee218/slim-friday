import { expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/runtime/system-prompt";

// EXPECTED TO FAIL until the owner runs `bash skill-overlays-staging/install-overlays.sh`: it checks that the
// REAL installed overlay files (vendored set) reach the real dev prompts. Without them the bootstrap's
// "Skill overlays below" reference is empty (harmless), but this test is the proof that installing worked.
test("installed overlays reach the dev plan and exec prompts", () => {
  for (const stage of ["plan", "exec"]) {
    const text = buildSystemPrompt("", stage).append;
    expect(text).toContain("## Skill overlays");
    for (const skill of ["writing-plans", "executing-plans", "brainstorming"])
      expect(text).toContain(`### superpowers:${skill}`);
  }
});

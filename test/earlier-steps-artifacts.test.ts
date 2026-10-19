import { expect, test } from "bun:test";
import { writeArtifact } from "../src/artifacts/artifact-writer";
import { logger } from "../src/observability/logger";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { earlierSteps } from "../src/orchestrator/worker/worker-end-event";
import { ROLES } from "../src/roles/role-registry";
import type { ItemRow } from "../src/storage/owned-item-store";
import { ownedTaskOfTurn } from "../src/storage/owned-task-store";
import { makeEnv } from "./helpers";

/* E-M8: the block handed to a DELEGATE chain's later step names the artifact ids of the earlier steps (ReadArtifact reads them). */

function setup(saved: number) {
  const { db, home } = makeEnv();
  const role = Object.values(ROLES).find((r) => r.kind === "worker")!.name;
  beginTurn(
    db,
    logger,
    { turnId: "t1", threadId: "th", source: "test" },
    { location: "*", role, brief: "b" },
  );
  const taskId = ownedTaskOfTurn(db, "t1")!;
  db.run("UPDATE owned_tasks SET parent_id = 'g1', item_key = 'main' WHERE id = ?", [taskId]);
  const ids = Array.from(
    { length: saved },
    (_, i) =>
      writeArtifact(db, home, {
        workspace: "main",
        channel: "general",
        taskId,
        threadId: "th",
        title: `file ${i}`,
        fallbackName: "x",
        kind: "md",
        body: `body ${i}`,
      }).id,
  );
  return { db, ids, next: { parentId: "g1", dependsOn: ["main"] } as unknown as ItemRow };
}

test("earlier steps block lists artifact ids and the ReadArtifact hint", () => {
  const { db, ids, next } = setup(2);
  const block = earlierSteps(db, next);
  for (const id of ids) expect(block).toContain(id);
  expect(block).toContain("ReadArtifact");
});

test("ids per step are capped; no artifacts = no hint", () => {
  const many = setup(8);
  const block = earlierSteps(many.db, many.next);
  expect(many.ids.filter((id) => block.includes(id)).length).toBe(5);
  const none = setup(0);
  expect(earlierSteps(none.db, none.next)).not.toContain("ReadArtifact");
});

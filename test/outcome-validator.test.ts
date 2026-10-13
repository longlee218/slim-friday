import { expect, test } from "bun:test";
import type { RunOutcome } from "../src/observability/record-run";
import type { DeliveryEvidence } from "../src/orchestrator/outputs/delivery-evidence";
import { expectsDelivery, validateOutcome } from "../src/orchestrator/outputs/outcome-validator";
import { ROLES } from "../src/roles/role-registry";

const roles = Object.values(ROLES);
const deliverer = roles.find((r) => expectsDelivery(r))!;
const answerer = roles.find((r) => !r.background)!;
const none: DeliveryEvidence = {
  actions: { commit: 0, push: 0, branch_create: 0, pr_create: 0, merge: 0, cherry_pick: 0 },
  artifacts: [],
  any: false,
};
const done: DeliveryEvidence = {
  actions: { ...none.actions, commit: 2 },
  artifacts: ["abc1234"],
  any: true,
};
const run = (outcome: RunOutcome, text = "t") => ({ outcome, text });

test("success with delivery evidence; a role that expects none is success without it", () => {
  const ok = validateOutcome(deliverer, run("success"), done, "tr1");
  expect(ok).toMatchObject({ status: "success", artifacts: ["abc1234"], traceId: "tr1" });
  expect(ok.actionsPerformed).toEqual(["commit:2"]);
  expect(validateOutcome(answerer, run("success"), none, "tr").status).toBe("success");
});

test("success without evidence from a delivering role is partial with a continue hint", () => {
  expect(validateOutcome(deliverer, run("success"), none, "tr")).toMatchObject({
    status: "partial",
    recoveryHint: "continue",
  });
});

test("max_turns with text is partial; error and timeout fail; quota and stop are blocked", () => {
  expect(validateOutcome(deliverer, run("max_turns"), none, "tr").status).toBe("partial");
  expect(validateOutcome(deliverer, run("max_turns", ""), none, "tr").status).toBe("failed");
  expect(validateOutcome(deliverer, run("error"), none, "tr")).toMatchObject({
    status: "failed",
    recoveryHint: "resume",
  });
  expect(validateOutcome(deliverer, run("timeout"), none, "tr")).toMatchObject({
    status: "failed",
    recoveryHint: "rephrase",
  });
  expect(validateOutcome(deliverer, run("quota"), none, "tr")).toMatchObject({
    status: "blocked",
    recoveryHint: "wait_quota",
  });
  expect(validateOutcome(deliverer, run("aborted"), none, "tr").status).toBe("blocked");
});

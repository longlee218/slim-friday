import { expect, test } from "bun:test";
import {
  expireOldProposals,
  getProposal,
  insertProposal,
  listPendingProposals,
  PROPOSAL_TTL_MS,
  pendingProposal,
  setProposalStatus,
} from "../src/storage/proposal-store";
import { makeEnv } from "./helpers";

const base = { threadId: "th1", workspace: "main", role: "dev", brief: "fix the thing in a.ts" };

test("insert -> pending row with every field; secrets in the brief are redacted", () => {
  const { db } = makeEnv();
  const id = insertProposal(
    db,
    {
      ...base,
      brief: `use ghp_${"a".repeat(36)}`,
      repo: "api",
      class: "design",
      fromTurnId: "t1",
      confidence: 0.8,
    },
    1000,
  );
  const p = getProposal(db, id)!;
  expect(p).toMatchObject({
    status: "pending",
    repo: "api",
    class: "design",
    fromTurnId: "t1",
    confidence: 0.8,
    createdAt: 1000,
    decidedAt: null,
  });
  expect(p.brief).not.toContain("ghp_");
  expect(getProposal(db, "nope")).toBeNull();
});

test("pendingProposal: newest pending of the thread only", () => {
  const { db } = makeEnv();
  const a = insertProposal(db, base, 1);
  const b = insertProposal(db, { ...base, brief: "second brief here" }, 2);
  insertProposal(db, { ...base, threadId: "other" }, 3);
  expect(pendingProposal(db, "th1")?.id).toBe(b);
  setProposalStatus(db, b, "dispatched");
  expect(pendingProposal(db, "th1")?.id).toBe(a);
  expect(listPendingProposals(db)).toHaveLength(2);
});

test("transitions: pending -> queued -> dispatched; terminal rows never change", () => {
  const { db } = makeEnv();
  const id = insertProposal(db, base);
  expect(setProposalStatus(db, id, "queued", 5)).toBe(true);
  expect(getProposal(db, id)).toMatchObject({ status: "queued", decidedAt: null });
  expect(setProposalStatus(db, id, "dispatched", 6)).toBe(true);
  expect(getProposal(db, id)).toMatchObject({ status: "dispatched", decidedAt: 6 });
  // A second dispatch or a late refusal is rejected and leaves the row alone.
  expect(setProposalStatus(db, id, "dispatched")).toBe(false);
  expect(setProposalStatus(db, id, "refused")).toBe(false);
  expect(setProposalStatus(db, "missing", "refused")).toBe(false);
  expect(getProposal(db, id)?.status).toBe("dispatched");
});

test("refused and expired from pending", () => {
  const { db } = makeEnv();
  const a = insertProposal(db, base);
  const b = insertProposal(db, base);
  expect(setProposalStatus(db, a, "refused")).toBe(true);
  expect(setProposalStatus(db, b, "expired")).toBe(true);
  expect(setProposalStatus(db, b, "queued")).toBe(false);
});

test("expireOldProposals: open ones older than 24h expire; fresh and decided ones stay", () => {
  const { db } = makeEnv();
  const now = 10 * PROPOSAL_TTL_MS;
  const old = insertProposal(db, base, now - PROPOSAL_TTL_MS - 1);
  const oldQueued = insertProposal(db, base, now - PROPOSAL_TTL_MS - 2);
  setProposalStatus(db, oldQueued, "queued");
  const fresh = insertProposal(db, base, now - PROPOSAL_TTL_MS + 1000);
  const done = insertProposal(db, base, now - PROPOSAL_TTL_MS - 3);
  setProposalStatus(db, done, "dispatched");
  expect(expireOldProposals(db, now)).toBe(2);
  expect(getProposal(db, old)?.status).toBe("expired");
  expect(getProposal(db, oldQueued)?.status).toBe("expired");
  expect(getProposal(db, fresh)?.status).toBe("pending");
  expect(getProposal(db, done)?.status).toBe("dispatched");
  expect(expireOldProposals(db, now)).toBe(0);
});

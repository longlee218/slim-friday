import { ORPCError } from "@orpc/client";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { ApprovalCard } from "../../src/components/chat/approval-card";
import { ApprovalReceipt } from "../../src/components/chat/approval-receipt";
import { ApprovalRow } from "../../src/components/chat/approval-row";
import { approvalTitle, scopeLine, toolLabel } from "../../src/components/chat/approval-text";
import type { Receipt } from "../../src/events/client-keys";
import { receiptsKey } from "../../src/events/client-keys";
import { apprCard, cardClient } from "./cards-fixtures";
import { view } from "./fixtures";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  answerQ: vi.fn(),
  toast: Object.assign(vi.fn(), { custom: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { approvals: { answer: mocks.approve }, questions: { answer: mocks.answerQ } },
}));

beforeEach(() => vi.clearAllMocks());

const r = (answer: "once" | "always" | "deny", tool = "GitPush"): Receipt => ({
  kind: "approval",
  card: apprCard({ tool }),
  answer,
});

test("button order and Always hidden when not offered", () => {
  view(<ApprovalCard card={apprCard({ offerAlways: false })} />);
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Deny", "Allow once"]);
});

test("button order with Always", () => {
  view(<ApprovalCard card={apprCard()} />);
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Deny",
    "Always allow",
    "Allow once",
  ]);
});

test("title and scope line", () => {
  expect(approvalTitle(apprCard())).toBe("Dev wants to use GitPush");
  expect(scopeLine({ repo: "friday", branch: "feat/x" })).toBe("feat/x");
  expect(scopeLine({ repo: "friday" })).toBe("friday");
  expect(scopeLine({})).toBe("");
});

test("shows summary, tool and scope rows, the exact input and the pill", () => {
  view(<ApprovalCard card={apprCard()} />);
  expect(screen.getByText("Dev wants to use GitPush")).toBeTruthy();
  expect(screen.getByText("Waiting for you")).toBeTruthy();
  expect(screen.getByText("Push the branch to origin.")).toBeTruthy();
  expect(screen.getByText("Tool").nextElementSibling?.textContent).toBe("GitPush");
  expect(screen.getByText("branch").nextElementSibling?.textContent).toBe("feat/x");
  expect(document.querySelector(".appr-input")?.textContent).toBe('{\n  "branch": "feat/x"\n}');
  expect(screen.queryByText(/Auto-denies/)).toBeNull();
});

test("allow once folds into a receipt", async () => {
  mocks.approve.mockResolvedValue({ ok: true });
  const card = apprCard();
  const qc = cardClient(card);
  const { container } = view(<ApprovalCard card={card} />, qc);
  await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
  expect(mocks.approve).toHaveBeenCalledWith({ cardId: "a1", answer: "once" });
  await waitFor(() => expect(screen.getByText(/You allowed once:/)).toBeTruthy());
  expect(screen.getByText("GitPush", { selector: "b" })).toBeTruthy();
  expect(container.querySelector(".appr")?.classList.contains("done")).toBe(true);
  expect(qc.getQueryData(orpc.approvals.pending.queryKey())).toEqual([]);
  expect(qc.getQueryData<Record<string, Receipt>>(receiptsKey())?.a1?.answer).toBe("once");
});

test("deny and always receipts", async () => {
  mocks.approve.mockResolvedValue({ ok: true });
  const card = apprCard();
  view(<ApprovalCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(mocks.approve).toHaveBeenCalledWith({ cardId: "a1", answer: "deny" });
  await waitFor(() => expect(screen.getByText(/You denied:/)).toBeTruthy());
});

test("always allow sends always", async () => {
  mocks.approve.mockResolvedValue({ ok: true });
  const card = apprCard();
  view(<ApprovalCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: "Always allow" }));
  expect(mocks.approve).toHaveBeenCalledWith({ cardId: "a1", answer: "always" });
  await waitFor(() => expect(screen.getByText(/You always allow:/)).toBeTruthy());
});

test("CONFLICT folds to Answered on another device, no error toast", async () => {
  mocks.approve.mockRejectedValue(new ORPCError("CONFLICT"));
  const card = apprCard();
  view(<ApprovalCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(screen.getByText("Answered on another device")).toBeTruthy());
  expect(mocks.toast).not.toHaveBeenCalled();
});

test("another error keeps the card open, re-enables buttons and toasts", async () => {
  mocks.approve.mockRejectedValue(new Error("boom"));
  const card = apprCard();
  const { container } = view(<ApprovalCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Could not send. Try again."));
  expect(container.querySelector(".appr")?.classList.contains("done")).toBe(false);
  expect((screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("a double click sends one request", async () => {
  mocks.approve.mockImplementation(() => new Promise(() => {}));
  const card = apprCard();
  view(<ApprovalCard card={card} />, cardClient(card));
  await userEvent.dblClick(screen.getByRole("button", { name: "Allow once" }));
  expect(mocks.approve).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
});

test("approval.closed first, then the answer: one receipt, event wins", async () => {
  const { closeApproval } = await import("../../src/events/apply-cards");
  mocks.approve.mockRejectedValue(new ORPCError("CONFLICT"));
  const card = apprCard();
  const qc = cardClient(card);
  view(<ApprovalCard card={card} />, qc);
  closeApproval(qc, "a1", "deny");
  await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(mocks.approve).toHaveBeenCalled());
  expect(qc.getQueryData<Record<string, Receipt>>(receiptsKey())?.a1?.answer).toBe("deny");
});

test("a receipt prop renders the folded line with right-aligned just now", () => {
  view(<ApprovalCard card={apprCard()} receipt={r("once")} />);
  expect(screen.getByText(/You allowed once:/).textContent).toContain("feat/x");
  expect(screen.getByText("just now")).toBeTruthy();
});

test("phone receipt", () => {
  view(<ApprovalReceipt receipt={r("deny", "MergeBranch")} />);
  expect(screen.getByText("Denied: MergeBranch")).toBeTruthy();
  expect(screen.getByText("feat/x")).toBeTruthy();
  view(<ApprovalReceipt receipt={r("once")} />);
  expect(screen.getByText("Allowed: GitPush")).toBeTruthy();
});

test("phone row: Review opens the sheet; Allow once answers and folds to the receipt", async () => {
  mocks.approve.mockResolvedValue({ ok: true });
  const card = apprCard();
  view(<ApprovalRow card={card} />, cardClient(card));
  expect(screen.getByText("GitPush")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Review" }));
  const order = screen.getAllByRole("button").map((b) => b.textContent);
  expect(order.slice(-3)).toEqual(["Allow once", "Always allow", "Deny"]);
  await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
  expect(mocks.approve).toHaveBeenCalledWith({ cardId: "a1", answer: "once" });
  await waitFor(() => expect(screen.getByText("Allowed: GitPush")).toBeTruthy());
});

test("elsewhere receipts are neutral, not green", () => {
  const el: Receipt = { kind: "approval", card: apprCard(), answer: "elsewhere" };
  const { container } = view(<ApprovalCard card={apprCard()} receipt={el} />);
  expect(container.querySelector(".ok.neutral")).toBeTruthy();
  const b = view(<ApprovalReceipt receipt={el} />);
  expect(b.container.querySelector(".ios-mini-appr.neutral")).toBeTruthy();
  expect(b.container.querySelector(".allow")).toBeNull();
});

test("a cut input shows the marker and only Deny", () => {
  view(
    <ApprovalCard
      card={apprCard({ input: '{\n  "c": "yy" [CUT: 5 more chars]', inputCut: true })}
    />,
  );
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Deny"]);
  expect(document.querySelector(".appr-input")?.textContent).toContain("[CUT: 5 more chars]");
  expect(screen.getByText(/can only be denied/)).toBeTruthy();
});

test("a withdrawn approval shows a neutral receipt, not a denial", () => {
  view(
    <ApprovalCard
      card={apprCard()}
      receipt={{ kind: "approval", card: apprCard(), answer: null }}
    />,
  );
  expect(screen.getByText("Withdrawn by the bot")).toBeTruthy();
  expect(screen.queryByText(/denied/i)).toBeNull();
});

test("MCP tool ids show as their short name in titles, rows and receipts", () => {
  expect(toolLabel("mcp__effects__GitPush")).toBe("GitPush");
  expect(toolLabel("mcp__my_server__Do__It")).toBe("Do__It");
  expect(toolLabel("Bash")).toBe("Bash");
  const mcp = apprCard({ tool: "mcp__effects__GitPush" });
  expect(approvalTitle(mcp)).toBe("Dev wants to use GitPush");
  view(<ApprovalRow card={mcp} />, cardClient(mcp));
  expect(screen.getByText("GitPush")).toBeTruthy();
  view(<ApprovalReceipt receipt={r("deny", "mcp__effects__MergeBranch")} />);
  expect(screen.getByText("Denied: MergeBranch")).toBeTruthy();
  view(<ApprovalCard card={mcp} receipt={r("once", "mcp__effects__GitPush")} />);
  expect(screen.getByText(/You allowed once:/).textContent).toContain("GitPush");
  expect(screen.getByText(/You allowed once:/).textContent).not.toContain("mcp__");
});

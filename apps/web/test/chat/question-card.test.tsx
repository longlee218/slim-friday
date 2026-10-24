import type { QuestionCardDto } from "@friday/contracts";
import { ORPCError } from "@orpc/client";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { QuestionCard } from "../../src/components/chat/question-card";
import type { Receipt } from "../../src/events/client-keys";
import { askCard, cardClient } from "./cards-fixtures";
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

const YN = [
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" },
];

/**
 * Copy of the server rule (`validCardAnswer` in packages/core/src/runs/run-card-answer.ts); apps/web may only
 * import @friday/contracts, so the rule is repeated here to prove the sent value is accepted.
 */
function validAnswer(card: QuestionCardDto, a: { choices: string[]; text?: string }): boolean {
  const text = a.text?.trim();
  if (text && !card.allowText) return false;
  if (a.choices.length === 0 && !text) return false;
  if (card.kind !== "multi" && a.choices.length > 1) return false;
  const values = new Set(card.options.map((o) => o.value));
  return a.choices.every((c) => values.has(c));
}

const send = () => screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;

test("single choice: Send disabled until a pick, sends the value", async () => {
  mocks.answerQ.mockResolvedValue({ ok: true });
  const card = askCard();
  view(<QuestionCard card={card} />, cardClient(card));
  expect(screen.getByText("Pia asks")).toBeTruthy();
  expect(screen.getByText("Pick one")).toBeTruthy();
  expect(screen.getByText("Smallest and simplest")).toBeTruthy();
  expect(send().disabled).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: /CSV only/ }));
  expect(send().disabled).toBe(false);
  await userEvent.click(send());
  expect(mocks.answerQ).toHaveBeenCalledWith({ cardId: "q1", choices: ["csv"] });
  await waitFor(() => expect(screen.getByText(/You answered:/).textContent).toContain("CSV only"));
});

test("single choice: picking another row moves the selection", async () => {
  const card = askCard();
  view(<QuestionCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: /CSV only/ }));
  await userEvent.click(screen.getByRole("button", { name: /Customer/ }));
  const on = screen.getAllByRole("button").filter((b) => b.classList.contains("on"));
  expect(on.map((b) => b.textContent)).toEqual(["Customer"]);
});

test("multi choice: Pick any and several values", async () => {
  mocks.answerQ.mockResolvedValue({ ok: true });
  const card = askCard({ kind: "multi" });
  view(<QuestionCard card={card} />, cardClient(card));
  expect(screen.getByText("Pick any")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /Invoice number/ }));
  await userEvent.click(screen.getByRole("button", { name: /Customer/ }));
  await userEvent.click(send());
  expect(mocks.answerQ).toHaveBeenCalledWith({ cardId: "q1", choices: ["number", "customer"] });
  await waitFor(() =>
    expect(screen.getByText(/You answered:/).textContent).toContain("Invoice number, Customer"),
  );
});

test("something else sends the text, trimmed", async () => {
  mocks.answerQ.mockResolvedValue({ ok: true });
  const card = askCard({ allowText: true });
  view(<QuestionCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: /Something else/ }));
  const input = screen.getByPlaceholderText("Your answer");
  expect(document.activeElement).toBe(input);
  await userEvent.type(input, "  PDF ");
  await userEvent.click(send());
  expect(mocks.answerQ).toHaveBeenCalledWith({ cardId: "q1", choices: [], text: "PDF" });
  await waitFor(() => expect(screen.getByText(/You answered:/).textContent).toContain("PDF"));
});

test("something else with no text sends Something else", async () => {
  mocks.answerQ.mockResolvedValue({ ok: true });
  const card = askCard({ allowText: true });
  view(<QuestionCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: /Something else/ }));
  await userEvent.click(send());
  expect(mocks.answerQ).toHaveBeenCalledWith({
    cardId: "q1",
    choices: [],
    text: "Something else",
  });
});

test("confirm sends the card's own option value and it passes the server rule", async () => {
  mocks.answerQ.mockResolvedValue({ ok: true });
  const card = askCard({ kind: "confirm", options: YN, question: "Post it in the crew?" });
  view(<QuestionCard card={card} />, cardClient(card));
  expect(screen.getByText("You can change this later in the chat.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Yes" }));
  const sent = mocks.answerQ.mock.calls[0]![0];
  expect(sent).toEqual({ cardId: "q1", choices: ["Yes"] });
  expect(validAnswer(card, sent)).toBe(true);
  await waitFor(() => expect(screen.getByText(/You answered:/).textContent).toContain("Yes"));
});

test("confirm No maps a lower-case option value", async () => {
  mocks.answerQ.mockResolvedValue({ ok: true });
  const card = askCard({
    kind: "confirm",
    options: [
      { value: "yes!", label: " YES " },
      { value: "nope", label: "no" },
    ],
  });
  view(<QuestionCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: "No" }));
  expect(mocks.answerQ).toHaveBeenCalledWith({ cardId: "q1", choices: ["nope"] });
  await waitFor(() => expect(screen.getByText(/You answered:/).textContent).toContain("No"));
});

test("confirm buttons are disabled when the card has no Yes/No option", () => {
  const card = askCard({ kind: "confirm", options: [{ value: "Yes", label: "Yes" }] });
  view(<QuestionCard card={card} />, cardClient(card));
  expect((screen.getByRole("button", { name: "No" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Yes" }) as HTMLButtonElement).disabled).toBe(false);
});

test("confirm receipts: a real Yes value reads Yes, No reads No, text-only shows the text", () => {
  const card = askCard({ kind: "confirm", options: YN });
  const rec = (answer: { choices: string[]; text?: string }): Receipt => ({
    kind: "question",
    card,
    answer,
  });
  const { unmount } = view(<QuestionCard card={card} receipt={rec({ choices: ["Yes"] })} />);
  expect(screen.getByText(/You answered:/).textContent).toContain("Yes");
  unmount();
  const b = view(<QuestionCard card={card} receipt={rec({ choices: ["No"] })} />);
  expect(screen.getByText(/You answered:/).textContent).toContain("No");
  b.unmount();
  view(<QuestionCard card={card} receipt={rec({ choices: [], text: "Maybe later" })} />);
  expect(screen.getByText(/You answered:/).textContent).toContain("Maybe later");
});

test("an option valued other does not clash with Something else", async () => {
  mocks.answerQ.mockResolvedValue({ ok: true });
  const card = askCard({
    allowText: true,
    options: [{ value: "other", label: "Other thing" }],
  });
  view(<QuestionCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: /Other thing/ }));
  const on = screen.getAllByRole("button").filter((b) => b.classList.contains("on"));
  expect(on.map((b) => b.textContent)).toEqual(["Other thing"]);
  await userEvent.click(send());
  expect(mocks.answerQ).toHaveBeenCalledWith({ cardId: "q1", choices: ["other"] });
});

test("timed-out question shows No answer in time", () => {
  const receipt: Receipt = { kind: "question", card: askCard(), answer: null };
  view(<QuestionCard card={askCard()} receipt={receipt} />);
  expect(screen.getByText("No answer in time")).toBeTruthy();
  expect(document.querySelector(".ok.neutral")).toBeTruthy();
});

test("a receipt from an event maps values to labels", () => {
  const receipt: Receipt = { kind: "question", card: askCard(), answer: { choices: ["csv"] } };
  view(<QuestionCard card={askCard()} receipt={receipt} />);
  expect(screen.getByText(/You answered:/).textContent).toContain("CSV only");
});

test("CONFLICT folds to Answered on another device, no toast", async () => {
  mocks.answerQ.mockRejectedValue(new ORPCError("CONFLICT"));
  const card = askCard({ kind: "confirm", options: YN });
  view(<QuestionCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: "Yes" }));
  await waitFor(() => expect(screen.getByText("Answered on another device")).toBeTruthy());
  expect(mocks.toast).not.toHaveBeenCalled();
});

test("another error keeps the card open and toasts", async () => {
  mocks.answerQ.mockRejectedValue(new Error("boom"));
  const card = askCard({ kind: "confirm", options: YN });
  view(<QuestionCard card={card} />, cardClient(card));
  await userEvent.click(screen.getByRole("button", { name: "Yes" }));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Could not send. Try again."));
  expect((screen.getByRole("button", { name: "Yes" }) as HTMLButtonElement).disabled).toBe(false);
});

test("a double click sends one request", async () => {
  mocks.answerQ.mockImplementation(() => new Promise(() => {}));
  const card = askCard({ kind: "confirm", options: YN });
  view(<QuestionCard card={card} />, cardClient(card));
  await userEvent.dblClick(screen.getByRole("button", { name: "Yes" }));
  expect(mocks.answerQ).toHaveBeenCalledTimes(1);
});

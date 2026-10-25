import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { BotMessage } from "../../src/components/chat/bot-message";
import { RunBlock } from "../../src/components/chat/run-block";
import { WorkedDisclosure } from "../../src/components/chat/worked-disclosure";
import type { LiveRun } from "../../src/events/client-keys";
import { msg, view } from "./fixtures";
import { step } from "./run-fixtures";

const run = (steps: LiveRun["steps"], tail?: string): LiveRun => ({
  botId: "dev",
  startedAt: 0,
  steps,
  tail,
});

/** Opens the run block's folded steps. */
const openRun = (c: HTMLElement) => {
  (c.querySelector("details.run-d") as HTMLDetailsElement).open = true;
};

test("the run block is folded until its header is clicked; the tail stays in view", async () => {
  const { container } = render(
    <RunBlock run={run([step("tool", "done", { label: "Read" })], "bun test")} now={1000} />,
  );
  const d = container.querySelector("details.run-d") as HTMLDetailsElement;
  expect(d.open).toBe(false);
  expect(container.querySelector(".tail")?.textContent).toBe("bun test");
  await userEvent.click(screen.getByText("Working"));
  expect(d.open).toBe(true);
});

test("run block shows Thinking with a counter from the turn start", () => {
  render(<RunBlock run={run([])} now={3000} />);
  expect(screen.getByText("Thinking")).toBeTruthy();
  expect(screen.getByText("3s")).toBeTruthy();
});

test("an edit step shows +42 and the minus 3", () => {
  const { container } = render(
    <RunBlock
      run={run([step("tool", "done", { label: "Edited", target: "a.ts", added: 42, removed: 3 })])}
      now={1000}
    />,
  );
  openRun(container);
  expect(screen.getByText("Working")).toBeTruthy();
  expect(screen.getByText("a.ts")).toBeTruthy();
  expect(screen.getByText("+42").className).toBe("add");
  expect(screen.getByText("−3").className).toBe("del");
});

test("a one-sided delta shows only the side that exists", () => {
  const { container } = render(
    <RunBlock run={run([step("tool", "done", { label: "Wrote", added: 12 })])} now={1000} />,
  );
  openRun(container);
  expect(container.querySelector(".delta")?.textContent).toBe("+12");
  expect(container.querySelector(".del")).toBeNull();
});

test("worked disclosure shows a stored running step as done, keeps failed", () => {
  const steps = [step("tool", "running", { id: "a" }), step("command", "failed", { id: "b" })];
  const { container } = render(<WorkedDisclosure steps={steps} />);
  const items = container.querySelectorAll(".run-steps li");
  expect(items[0]?.getAttribute("data-state")).toBe("done");
  expect(items[0]?.querySelector(".spin")).toBeNull();
  expect(items[1]?.getAttribute("data-state")).toBe("failed");
});

test("worked disclosure is hidden when no step is visible", () => {
  const { container } = render(
    <WorkedDisclosure steps={[step("thinking", "done"), step("writing", "done", { id: "w" })]} />,
  );
  expect(container.querySelector("details.worked")).toBeNull();
});

test("running step has a spinner, done a check, failed an x; thinking steps hidden", () => {
  const { container } = render(
    <RunBlock
      run={run(
        [
          step("thinking", "done"),
          step("tool", "done", { id: "a" }),
          step("command", "running", { id: "b" }),
          step("mcp", "failed", { id: "c" }),
        ],
        "bun test",
      )}
      now={1000}
    />,
  );
  openRun(container);
  const items = container.querySelectorAll(".run-steps li");
  expect(items).toHaveLength(3);
  expect(items[0]?.getAttribute("data-state")).toBe("done");
  expect(items[0]?.querySelector(".lucide-check")).toBeTruthy();
  expect(items[1]?.getAttribute("data-state")).toBe("running");
  expect(items[1]?.querySelector(".spin")).toBeTruthy();
  expect(items[2]?.getAttribute("data-state")).toBe("failed");
  expect(items[2]?.querySelector(".lucide-x")).toBeTruthy();
  expect(container.querySelector(".tail")?.textContent).toBe("bun test");
});

test("worked disclosure summary and open list", async () => {
  const steps = [
    step("tool", "done", {
      id: "a",
      label: "Edited",
      target: "a.ts",
      startedAt: 0,
      endedAt: 42_000,
    }),
  ];
  const { container } = render(<WorkedDisclosure steps={steps} />);
  expect(screen.getByText("Worked for 42s · 1 step")).toBeTruthy();
  await userEvent.click(screen.getByText("Worked for 42s · 1 step"));
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector(".run-steps li")?.getAttribute("data-state")).toBe("done");
});

test("bot message shows the disclosure only with a non-empty run", () => {
  const a = view(<BotMessage message={msg()} phone={false} onReply={() => {}} />);
  expect(a.container.querySelector("details.worked")).toBeNull();
  a.unmount();
  const b = view(<BotMessage message={msg({ run: [] })} phone={false} onReply={() => {}} />);
  expect(b.container.querySelector("details.worked")).toBeNull();
  b.unmount();
  const c = view(
    <BotMessage message={msg({ run: [step("tool", "done")] })} phone={false} onReply={() => {}} />,
  );
  expect(c.container.querySelector("details.worked")).toBeTruthy();
});

import { screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { BotMessage } from "../../src/components/chat/bot-message";
import { ScheduleTag } from "../../src/components/chat/schedule-tag";
import { schedule } from "../schedules/fixtures";
import { chatClient, msg, NOW, view } from "./fixtures";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => vi.useRealTimers());

const tag = { id: "s1", name: "Morning news" };

test("the tag links to the schedule while it exists", () => {
  view(<ScheduleTag schedule={tag} exists />);
  const link = screen.getByRole("link", { name: "Schedule Morning news" });
  expect(link.getAttribute("href")).toBe("/schedules/s1");
  expect(link.querySelector(".lucide-calendar-clock")).toBeTruthy();
});

test("the tag of a deleted schedule is plain text", () => {
  const { container } = view(<ScheduleTag schedule={tag} exists={false} />);
  expect(screen.getByText("Morning news")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(container.querySelector(".sched-tag.gone")).toBeTruthy();
});

/** A bot message from schedule s1, with `items` in the schedules list. */
function renderMessage(items: ReturnType<typeof schedule>[]) {
  const qc = chatClient();
  qc.setQueryData(orpc.schedules.list.queryKey({ input: {} }), { items });
  return view(<BotMessage message={msg({ schedule: tag })} phone={false} onReply={() => {}} />, qc);
}

test("a bot message from a schedule shows the tag as a link", () => {
  renderMessage([schedule("s1")]);
  expect(screen.getByRole("link", { name: "Schedule Morning news" }).getAttribute("href")).toBe(
    "/schedules/s1",
  );
});

test("a bot message from a deleted schedule shows the tag as text", () => {
  renderMessage([]);
  expect(screen.getByText("Morning news")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Schedule Morning news" })).toBeNull();
});

test("a bot message without a schedule has no tag", () => {
  const { container } = view(<BotMessage message={msg()} phone={false} onReply={() => {}} />);
  expect(container.querySelector(".sched-tag")).toBeNull();
});

test("before the schedules list loads (or when it fails) the tag is the plain name, not gone", () => {
  const { container } = view(
    <BotMessage message={msg({ schedule: tag })} phone={false} onReply={() => {}} />,
  );
  expect(screen.getByText("Morning news")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(container.querySelector(".sched-tag")).toBeTruthy();
  expect(container.querySelector(".sched-tag.gone")).toBeNull();
});

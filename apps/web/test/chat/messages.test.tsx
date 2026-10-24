import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BotMessage } from "../../src/components/chat/bot-message";
import { FileCard } from "../../src/components/chat/file-card";
import { MessageActions } from "../../src/components/chat/message-actions";
import { OwnerBubble } from "../../src/components/chat/owner-bubble";
import { RelayCard } from "../../src/components/chat/relay-card";
import { DayLine, SystemLine } from "../../src/components/chat/system-line";
import { chatClient, doc, image, msg, NOW, view } from "./fixtures";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => vi.useRealTimers());

const relay = (intent: "request" | "handoff" | "result", state?: string) =>
  msg({
    kind: "relay",
    author: { kind: "system" },
    text: "Ship FRI-12 today",
    relay: { fromBotId: "pia", toBotId: "dev", intent, state },
  });

test("relay verbs and pills", () => {
  const { container, unmount } = view(<RelayCard message={relay("handoff", "Handed off")} />);
  expect(screen.getByText("hands off to")).toBeTruthy();
  expect(container.querySelector(".pill.violet")?.textContent).toBe("handoff");
  expect(container.querySelector(".lucide-check")).toBeTruthy();
  expect(screen.getByRole("link", { name: "FRI-12" }).getAttribute("href")).toBe("/tickets/FRI-12");
  unmount();
  const res = view(<RelayCard message={relay("result", "Done")} />);
  expect(screen.getByText("replies to")).toBeTruthy();
  expect(res.container.querySelector(".pill.green")?.textContent).toBe("result");
  expect(res.container.querySelector(".lucide-corner-down-left")).toBeTruthy();
  expect(screen.getByText("Done")).toBeTruthy();
});

test("relay request is blue and says asks", () => {
  const { container } = view(<RelayCard message={relay("request")} />);
  expect(screen.getByText("asks")).toBeTruthy();
  expect(container.querySelector(".pill.blue")).toBeTruthy();
});

test("owner bubble shows the reply quote and route", () => {
  const m = msg({
    author: { kind: "user" },
    text: "Thanks",
    replyTo: { messageId: 4, botId: "dev", excerpt: "Pushed." },
  });
  const { container } = view(
    <OwnerBubble message={m} route={{ botIds: ["dev"], reason: "reply" }} members={["dev"]} />,
  );
  const quote = container.querySelector(".quote") as HTMLElement;
  expect(within(quote).getByText("Dev")).toBeTruthy();
  expect(within(quote).getByText("Pushed.")).toBeTruthy();
  expect((container.querySelector(".route-meta") as HTMLElement).textContent).toBe("→ Dev · reply");
  expect(container.querySelector(".owner-meta")?.textContent).toContain("14:09");
});

test("owner route copy for direct and entry", () => {
  const m = msg({ author: { kind: "user" } });
  const a = view(<OwnerBubble message={m} route={{ botIds: ["dev"], reason: "direct" }} />);
  expect(a.container.querySelector(".route-meta")?.textContent).toBe("→ Dev");
  a.unmount();
  const b = view(<OwnerBubble message={m} route={{ botIds: ["pia"], reason: "entry" }} />);
  expect(b.container.querySelector(".route-meta")?.textContent).toBe("→ Pia · entry");
  b.unmount();
  const c = view(<OwnerBubble message={m} route={{ botIds: ["pia", "dev"], reason: "named" }} />);
  expect(c.container.querySelector(".route-meta")?.textContent).toBe("→ Pia, Dev");
});

test("owner @name highlights members only, as text", () => {
  const m = msg({ author: { kind: "user" }, text: "@dev and @sam <b>x</b>" });
  const { container } = view(<OwnerBubble message={m} members={["dev"]} />);
  const ats = [...container.querySelectorAll(".at")].map((e) => e.textContent);
  expect(ats).toEqual(["@dev"]);
  expect(container.querySelector("b")).toBeNull();
});

test("owner bubble failed state retries", async () => {
  const onRetry = vi.fn();
  view(
    <OwnerBubble message={msg({ author: { kind: "user" } })} pending="failed" onRetry={onRetry} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalled();
  expect(screen.getByText(/Not sent/)).toBeTruthy();
});

test("bot message splits images and files", () => {
  const m = msg({ files: [image("a"), image("b"), doc()] });
  const { container } = view(
    <BotMessage message={m} phone={false} onReply={() => {}} />,
    chatClient(["a", "b"]),
  );
  expect(container.querySelector(".gallery.n2")).toBeTruthy();
  expect(container.querySelectorAll(".file")).toHaveLength(1);
  expect(screen.getByText("Dev")).toBeTruthy();
  expect(screen.getByText("14:09")).toBeTruthy();
});

test("bot message on the phone has a 28 px avatar and no actions", () => {
  const { container } = view(<BotMessage message={msg()} phone onReply={() => {}} />);
  expect((container.querySelector(".av") as HTMLElement).style.width).toBe("28px");
  expect(container.querySelector(".msg-acts")).toBeNull();
});

test("message actions are present but hidden until hover", async () => {
  const onReply = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  view(<MessageActions message={msg({ text: "copy me" })} onReply={onReply} />);
  await userEvent.click(screen.getByRole("button", { name: "Reply to Dev" }));
  expect(onReply).toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith("copy me");
});

test("file card label", () => {
  view(<FileCard file={doc()} />);
  expect(screen.getByText("notes.md")).toBeTruthy();
  expect(screen.getByText("4 KB · Markdown")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
});

test("system and day lines", () => {
  const { container } = view(
    <>
      <SystemLine message={msg({ author: { kind: "system" }, text: "Dev joined FRI-3" })} />
      <DayLine at={NOW} />
      <DayLine at={NOW - 86_400_000} />
    </>,
  );
  expect(container.querySelector(".sys .lucide-info")).toBeTruthy();
  expect(screen.getByRole("link", { name: "FRI-3" })).toBeTruthy();
  expect([...container.querySelectorAll(".day")].map((d) => d.textContent)).toEqual([
    "Today",
    "Yesterday",
  ]);
});

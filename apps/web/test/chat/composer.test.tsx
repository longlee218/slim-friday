import type { BotDto, ConversationDto, GroupDto, MessageDto } from "@friday/contracts";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { Composer, type ReplyTarget } from "../../src/components/chat/composer";
import { usePendingSends } from "../../src/components/chat/pending-sends";
import { useSendMessage } from "../../src/components/chat/use-send-message";
import { appendMessage, messagesKey } from "../../src/events/apply-messages";
import { type LiveRun, liveRunKey } from "../../src/events/client-keys";
import { bot, conv, group, seededClient } from "../shell/fixtures";
import { msg, view } from "./fixtures";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  uploadCreate: vi.fn(),
  toast: Object.assign(vi.fn(), { custom: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { chat: { send: mocks.send, uploadCreate: mocks.uploadCreate } },
}));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true });
  mocks.send.mockResolvedValue({ messageId: 50 });
  mocks.uploadCreate.mockResolvedValue({
    uploadId: "11111111-1111-4111-8111-111111111111",
    putUrl: "https://r2/p",
  });
});

const bots: BotDto[] = [
  { ...bot("pia", "Pia"), title: "Lead" },
  { ...bot("tess", "Tess"), title: "QA" },
  { ...bot("dev", "Dev"), title: "Developer" },
];
const crew: GroupDto = group("crew", "Crew", ["pia", "tess", "dev"]);
const crewConv: ConversationDto = conv("group:crew", 0);
const devConv: ConversationDto = { ...conv("bot:dev", 0), botId: "dev", title: "Dev" };

/** A client with the three bots and an empty transcript page for each conversation. */
function client(): QueryClient {
  const qc = seededClient({ bots, groups: [crew] });
  for (const id of ["group:crew", "bot:dev"]) {
    qc.setQueryData<InfiniteData<MessageDto[], number | undefined>>(messagesKey(id), {
      pages: [[]],
      pageParams: [undefined],
    });
  }
  return qc;
}

const ids = (qc: QueryClient, id: string) =>
  qc
    .getQueryData<InfiniteData<MessageDto[]>>(messagesKey(id))
    ?.pages.flat()
    .map((m) => m.id);

/** The composer with its draft state, plus the pending list and Retry buttons the chat view will own. */
function Harness(p: {
  conversation: ConversationDto;
  group?: GroupDto;
  phone?: boolean;
  reply?: ReplyTarget | null;
  onEsc?(): void;
}) {
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState<ReplyTarget | null>(p.reply ?? null);
  const pending = usePendingSends();
  const sender = useSendMessage();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: probes that Escape does not bubble
    <div onKeyDown={(e) => e.key === "Escape" && p.onEsc?.()}>
      <Composer
        conversation={p.conversation}
        group={p.group}
        phone={p.phone ?? false}
        reply={reply}
        onClearReply={() => setReply(null)}
        draft={draft}
        onDraft={setDraft}
      />
      {Object.entries(pending).map(([id, s]) => (
        <button type="button" key={id} onClick={() => sender.retry(Number(id))}>
          {`${s.state} ${id}`}
        </button>
      ))}
    </div>
  );
}

const input = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const sendBtn = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
const REPLY: ReplyTarget = { messageId: 7, botId: "dev", excerpt: "Pushed the branch" };

test("Send is labelled Send and disabled until there is text", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  expect(sendBtn().disabled).toBe(true);
  await u.type(input(), "hi");
  expect(sendBtn().disabled).toBe(false);
});

test("placeholders and aria-label", () => {
  const a = view(<Harness conversation={devConv} />, client());
  expect(input().placeholder).toBe("Message Dev");
  a.unmount();
  const b = view(<Harness conversation={crewConv} group={crew} />, client());
  expect(input().placeholder).toBe("Message Crew · @ to address a member");
  b.unmount();
  const c = view(<Harness conversation={devConv} phone />, client());
  expect(input().placeholder).toBe("Message");
  c.unmount();
  view(<Harness conversation={crewConv} group={crew} phone />, client());
  expect(input().placeholder).toBe("Message · @ a member");
});

test("composer sends with replyTo and clears the reply bar", async () => {
  const u = userEvent.setup();
  const { container } = view(
    <Harness conversation={crewConv} group={crew} reply={REPLY} />,
    client(),
  );
  expect(screen.getByText("Replying to Dev")).toBeTruthy();
  expect(container.querySelector(".route")?.textContent).toBe("To Dev · reply");
  await u.type(input(), "looks good");
  await u.click(sendBtn());
  expect(mocks.send).toHaveBeenCalledWith({
    conversationId: "group:crew",
    text: "looks good",
    replyTo: 7,
    clientNonce: expect.any(String),
  });
  expect(screen.queryByText("Replying to Dev")).toBeNull();
  expect(input().value).toBe("");
});

test("Cancel reply closes the bar", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={crewConv} group={crew} reply={REPLY} />, client());
  await u.click(screen.getByRole("button", { name: "Cancel reply" }));
  expect(screen.queryByText("Replying to Dev")).toBeNull();
});

test("optimistic message shows at once under a negative id, then swaps to the real id", async () => {
  let done: (v: { messageId: number }) => void = () => {};
  mocks.send.mockReturnValue(new Promise((r) => (done = r)));
  const u = userEvent.setup();
  const qc = client();
  view(<Harness conversation={devConv} />, qc);
  await u.type(input(), "hi");
  await u.click(sendBtn());
  const [tempId] = ids(qc, "bot:dev") ?? [];
  expect(tempId).toBeLessThan(0);
  expect(screen.getByRole("button", { name: `sending ${tempId}` })).toBeTruthy();
  await act(async () => done({ messageId: 50 }));
  expect(ids(qc, "bot:dev")).toEqual([50]);
  await waitFor(() => expect(screen.queryByRole("button", { name: /sending/ })).toBeNull());
});

test("temp id is dropped when the real message already arrived by event", async () => {
  let done: (v: { messageId: number }) => void = () => {};
  mocks.send.mockReturnValue(new Promise((r) => (done = r)));
  const u = userEvent.setup();
  const qc = client();
  view(<Harness conversation={devConv} />, qc);
  await u.type(input(), "hi");
  await u.click(sendBtn());
  act(() => appendMessage(qc, msg({ id: 50, author: { kind: "user" }, text: "hi" })));
  expect(ids(qc, "bot:dev")).toHaveLength(2);
  await act(async () => done({ messageId: 50 }));
  expect(ids(qc, "bot:dev")).toEqual([50]);
});

test("send failure keeps the message as failed; Retry resends the same payload", async () => {
  mocks.send.mockRejectedValueOnce(new Error("down"));
  const u = userEvent.setup();
  const qc = client();
  view(<Harness conversation={devConv} />, qc);
  await u.type(input(), "hi");
  await u.click(sendBtn());
  const failed = await screen.findByRole("button", { name: /^failed -\d+$/ });
  expect(qc.getQueryData<Record<string, LiveRun>>(liveRunKey("bot:dev"))?.dev).toBeUndefined();
  await u.click(failed);
  await waitFor(() => expect(ids(qc, "bot:dev")).toEqual([50]));
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.send.mock.calls[1]).toEqual(mocks.send.mock.calls[0]);
});

test("each message gets its own clientNonce and a Retry reuses it", async () => {
  mocks.send.mockRejectedValueOnce(new Error("down"));
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  await u.type(input(), "one");
  await u.click(sendBtn());
  await u.click(await screen.findByRole("button", { name: /^failed -\d+$/ }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
  await u.type(input(), "two");
  await u.click(sendBtn());
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(3));
  const nonces = mocks.send.mock.calls.map((c) => c[0].clientNonce);
  expect(nonces[0]).toBeTruthy();
  expect(nonces[1]).toBe(nonces[0]);
  expect(nonces[2]).toBeTruthy();
  expect(nonces[2]).not.toBe(nonces[0]);
});

test("sending starts a live run for the routed bot", async () => {
  const u = userEvent.setup();
  const qc = client();
  view(<Harness conversation={crewConv} group={crew} />, qc);
  await u.type(input(), "@Tess @Dev go");
  await u.click(sendBtn());
  const runs = qc.getQueryData<Record<string, LiveRun>>(liveRunKey("group:crew")) ?? {};
  expect(Object.keys(runs).sort()).toEqual(["dev", "tess"]);
  await waitFor(() => expect(mocks.send).toHaveBeenCalled());
});

test("direct chat starts the conversation's bot and shows no route chip", async () => {
  const u = userEvent.setup();
  const qc = client();
  const { container } = view(<Harness conversation={devConv} />, qc);
  expect(container.querySelector(".route")).toBeNull();
  await u.type(input(), "hi");
  await u.click(sendBtn());
  expect(
    Object.keys(qc.getQueryData<Record<string, LiveRun>>(liveRunKey("bot:dev")) ?? {}),
  ).toEqual(["dev"]);
});

test("Enter sends, Shift+Enter does not", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  await u.type(input(), "a{Shift>}{Enter}{/Shift}b");
  expect(mocks.send).not.toHaveBeenCalled();
  expect(input().value).toBe("a\nb");
  await u.type(input(), "{Enter}");
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

test("phone Enter adds a line instead of sending", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={devConv} phone />, client());
  await u.type(input(), "a{Enter}b");
  expect(mocks.send).not.toHaveBeenCalled();
  expect(input().value).toBe("a\nb");
});

test("route chip follows the text in a group", async () => {
  const u = userEvent.setup();
  const { container } = view(<Harness conversation={crewConv} group={crew} />, client());
  const chip = () => container.querySelector(".route")?.textContent;
  expect(chip()).toBe("To Pia · entry");
  await u.type(input(), "@Tess hi");
  expect(chip()).toBe("To Tess");
});

test("mention popover: arrows move, Enter picks, Tab picks, Esc closes and stops propagation", async () => {
  const u = userEvent.setup();
  const onEsc = vi.fn();
  view(<Harness conversation={crewConv} group={crew} onEsc={onEsc} />, client());
  await u.type(input(), "hi @");
  expect(screen.getByText("Members of Crew")).toBeTruthy();
  expect(screen.getByText("entry · Lead")).toBeTruthy();
  const rows = () => screen.getAllByRole("option");
  expect(rows()).toHaveLength(3);
  expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
  await u.keyboard("{ArrowDown}");
  expect(rows()[1]?.getAttribute("aria-selected")).toBe("true");
  await u.keyboard("{ArrowUp}{ArrowUp}");
  expect(rows()[2]?.getAttribute("aria-selected")).toBe("true");
  await u.keyboard("{Enter}");
  expect(input().value).toBe("hi @Dev ");
  expect(mocks.send).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).toBeNull();

  await u.type(input(), "@te");
  expect(rows()).toHaveLength(1);
  await u.keyboard("{Tab}");
  expect(input().value).toBe("hi @Dev @Tess ");

  await u.type(input(), "@");
  await u.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onEsc).not.toHaveBeenCalled();
});

test("mention popover closes 120 ms after blur", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={crewConv} group={crew} />, client());
  await u.type(input(), "@");
  expect(screen.getByRole("listbox")).toBeTruthy();
  await u.tab();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
});

test("a click on a member picks it", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={crewConv} group={crew} />, client());
  await u.type(input(), "@t");
  await u.click(screen.getByRole("option", { name: /Tess/ }));
  expect(input().value).toBe("@Tess ");
});

test("no popover in a direct chat", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  await u.type(input(), "@");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("send waits for the upload, then sends its id", async () => {
  let put: (v: { ok: boolean }) => void = () => {};
  fetchMock.mockReturnValue(new Promise((r) => (put = r)));
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  const file = new File(["abc"], "a.png", { type: "image/png" });
  await u.upload(screen.getByTestId("file-input"), file);
  expect(screen.getByText("a.png")).toBeTruthy();
  expect(sendBtn().disabled).toBe(true);
  await u.type(input(), "see");
  expect(sendBtn().disabled).toBe(true);
  await act(async () => put({ ok: true }));
  await waitFor(() => expect(sendBtn().disabled).toBe(false));
  await u.click(sendBtn());
  expect(mocks.send).toHaveBeenCalledWith({
    conversationId: "bot:dev",
    text: "see",
    uploadIds: ["11111111-1111-4111-8111-111111111111"],
    clientNonce: expect.any(String),
  });
  expect(screen.queryByText("a.png")).toBeNull();
});

test("a failed PUT keeps Send disabled and says why", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 403 });
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  await u.upload(
    screen.getByTestId("file-input"),
    new File(["abc"], "a.png", { type: "image/png" }),
  );
  await screen.findByText("Upload failed. Try again.");
  await u.type(input(), "hi");
  expect(sendBtn().disabled).toBe(true);
  await u.click(screen.getByRole("button", { name: "Remove a.png" }));
  expect(sendBtn().disabled).toBe(false);
});

test("a sixth file toasts the refusal and calls nothing", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  const files = Array.from(
    { length: 6 },
    (_, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" }),
  );
  await u.upload(screen.getByTestId("file-input"), files);
  expect(mocks.toast).toHaveBeenCalledWith("Up to 5 files per message.");
  expect(mocks.uploadCreate).not.toHaveBeenCalled();
});

test("pasting a file attaches it instead of inserting text", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  const file = new File(["abc"], "shot.png", { type: "image/png" });
  await u.click(input());
  fireEvent.paste(input(), { clipboardData: { files: [file] } });
  await screen.findByText("shot.png");
  expect(mocks.uploadCreate).toHaveBeenCalled();
});

test("Enter and ArrowDown while composing neither pick nor send", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={crewConv} group={crew} />, client());
  await u.type(input(), "xin @");
  fireEvent.keyDown(input(), { key: "ArrowDown", isComposing: true });
  expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
  fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
  expect(input().value).toBe("xin @");
  expect(mocks.send).not.toHaveBeenCalled();
});

test("Enter spam sends once", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  await u.type(input(), "hi{Enter}{Enter}{Enter}");
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

test("text keeps leading indentation and drops trailing whitespace", async () => {
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  await u.type(input(), "  code  ");
  await u.click(sendBtn());
  expect(mocks.send.mock.calls[0]?.[0].text).toBe("  code");
});

test("Retry that gets CONFLICT drops the temp message and its pending entry", async () => {
  mocks.send.mockRejectedValueOnce(new Error("down"));
  mocks.send.mockRejectedValueOnce(Object.assign(new Error("used"), { code: "CONFLICT" }));
  const u = userEvent.setup();
  const qc = client();
  view(<Harness conversation={devConv} />, qc);
  await u.type(input(), "hi");
  await u.click(sendBtn());
  await u.click(await screen.findByRole("button", { name: /^failed -\d+$/ }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /failed|sending/ })).toBeNull());
  expect(ids(qc, "bot:dev")).toEqual([]);
});

test("a double click on Retry sends once", async () => {
  let done: (v: { messageId: number }) => void = () => {};
  mocks.send.mockRejectedValueOnce(new Error("down"));
  mocks.send.mockReturnValueOnce(new Promise((r) => (done = r)));
  const u = userEvent.setup();
  view(<Harness conversation={devConv} />, client());
  await u.type(input(), "hi");
  await u.click(sendBtn());
  const failed = await screen.findByRole("button", { name: /^failed -\d+$/ });
  await u.dblClick(failed);
  expect(mocks.send).toHaveBeenCalledTimes(2);
  await act(async () => done({ messageId: 50 }));
});

test("a settled send sweeps pending entries whose temp message is gone", async () => {
  mocks.send.mockRejectedValueOnce(new Error("down"));
  const u = userEvent.setup();
  const qc = client();
  view(<Harness conversation={devConv} />, qc);
  await u.type(input(), "one");
  await u.click(sendBtn());
  await screen.findByRole("button", { name: /^failed/ });
  // A resync replaced the page: the temp message is gone.
  act(() => {
    qc.setQueryData(messagesKey("bot:dev"), { pages: [[]], pageParams: [undefined] });
  });
  await u.type(input(), "two");
  await u.click(sendBtn());
  await waitFor(() => expect(screen.queryByRole("button", { name: /failed|sending/ })).toBeNull());
});

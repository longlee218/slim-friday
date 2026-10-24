import type { FileDto, MessageDto } from "@friday/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { bot, seededClient } from "../shell/fixtures";

// jsdom has no matchMedia; ticket links read it for view transitions.
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

export const NOW = new Date(2026, 9, 25, 14, 9).getTime();

/** A bot text message at `NOW`. */
export const msg = (extra: Partial<MessageDto> = {}): MessageDto => ({
  id: 1,
  conversationId: "bot:dev",
  author: { kind: "bot", botId: "dev" },
  kind: "text",
  text: "Hello",
  at: NOW,
  files: [],
  ...extra,
});

export const image = (id: string, extra: Partial<FileDto> = {}): FileDto => ({
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  size: 212 * 1024,
  kind: "image",
  ...extra,
});

export const doc = (id = "f-doc"): FileDto => ({
  id,
  name: "notes.md",
  mimeType: "text/markdown",
  size: 4096,
  kind: "file",
});

/** A client with Dev, Pia and Sam seeded and a CDN url for every given file id. */
export function chatClient(fileIds: string[] = []): QueryClient {
  const qc = seededClient({ bots: [bot("dev", "Dev"), bot("pia", "Pia"), bot("sam", "Sam")] });
  for (const id of fileIds) {
    qc.setQueryData(orpc.chat.file.queryKey({ input: { id } }), { url: `https://cdn/${id}` });
  }
  return qc;
}

/** Render inside the query client and a router (ticket links navigate in-app). */
export function view(ui: ReactElement, qc: QueryClient = chatClient()) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

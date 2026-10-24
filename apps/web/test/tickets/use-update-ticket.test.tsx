import type { TicketDto } from "@friday/contracts";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { ticketListOptions } from "../../src/components/tickets/use-tickets";
import { useUpdateTicket } from "../../src/components/tickets/use-update-ticket";
import { ticket } from "./fixtures";

const update = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi({ update }));

type Page = { items: TicketDto[]; nextCursor?: string };
let qc: QueryClient;
const status = () =>
  qc.getQueryData<InfiniteData<Page>>(ticketListOptions.queryKey)!.pages[0]!.items[0]!.status;

beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  qc.setQueryData<InfiniteData<Page, string | undefined>>(ticketListOptions.queryKey, {
    pages: [{ items: [ticket(1, { updatedAt: 42 })] }],
    pageParams: [undefined],
  });
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

test("shows the status at once, then rolls back and toasts on CONFLICT", async () => {
  let reject!: (e: unknown) => void;
  update.mockReturnValue(new Promise((_, r) => (reject = r)));
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const { result } = renderHook(() => useUpdateTicket(), { wrapper });
  act(() => result.current.mutate({ ref: "FRI-1", status: "doing" }));
  await waitFor(() => expect(status()).toBe("doing"));
  expect(update).toHaveBeenCalledWith({ ref: "FRI-1", status: "doing", expectedUpdatedAt: 42 });
  await act(async () => reject(Object.assign(new Error("stale"), { code: "CONFLICT" })));
  await waitFor(() => expect(status()).toBe("todo"));
  expect(toast).toHaveBeenCalledWith("Changed elsewhere. Showing the latest.");
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: orpc.tickets.get.key({ input: { ref: "FRI-1" } }),
  });
});

test("a success keeps the server version", async () => {
  update.mockResolvedValue(ticket(1, { status: "doing", updatedAt: 50 }));
  const { result } = renderHook(() => useUpdateTicket(), { wrapper });
  await act(() => result.current.mutateAsync({ ref: "FRI-1", status: "doing" }));
  expect(status()).toBe("doing");
  expect(toast).not.toHaveBeenCalled();
});

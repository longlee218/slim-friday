import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { FileCard } from "../../src/components/chat/file-card";
import { FilePreview, previewKind } from "../../src/components/files/file-preview";

const mode = vi.hoisted(() => ({ value: "loadError" as "loadError" | "password" | "ok" }));
vi.mock("pdfjs-worker?url", () => ({ default: "/worker.mjs" }));
vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: (p: {
    children: ReactNode;
    onLoadError(e: Error): void;
    onPassword(): void;
    onLoadSuccess(d: { numPages: number }): void;
  }) => {
    // biome-ignore lint/correctness/useExhaustiveDependencies: fire once on mount
    useEffect(() => {
      if (mode.value === "loadError") p.onLoadError(new Error("bad"));
      else if (mode.value === "password") p.onPassword();
      else p.onLoadSuccess({ numPages: 3 });
    }, []);
    return <div>{p.children}</div>;
  },
  Page: ({ pageNumber }: { pageNumber: number }) => <div>{`page ${pageNumber}`}</div>,
}));

const api = vi.hoisted(() => ({ file: vi.fn() }));
vi.mock("../../src/api/client", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  const client = { chat: api };
  return { client, orpc: createTanstackQueryUtils(client as never) };
});

const file = {
  id: "f1",
  name: "r.pdf",
  mimeType: "application/pdf",
  kind: "pdf",
  size: 10,
} as never;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.resetAllMocks();
  api.file.mockResolvedValue({ url: "https://files.test/x.pdf" });
});

test("previewKind routes by mime type", () => {
  expect(previewKind({ mimeType: "application/pdf" })).toBe("pdf");
  expect(previewKind({ mimeType: "image/webp" })).toBe("image");
  expect(previewKind({ mimeType: "text/csv" })).toBe("other");
});

test("a PDF that fails to load shows an error line and Download", async () => {
  mode.value = "loadError";
  wrap(<FilePreview file={file} onClose={() => {}} />);
  expect(await screen.findByText("Could not open this PDF.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
});

test("a password-protected PDF shows an error line and Download downloads", async () => {
  mode.value = "password";
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  wrap(<FilePreview file={file} onClose={() => {}} />);
  expect(await screen.findByText("This PDF is password protected.")).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("button", { name: "Download" }));
  await vi.waitFor(() => expect(click).toHaveBeenCalled());
});

test("a URL lookup failure shows an error and Download", async () => {
  api.file.mockRejectedValue(new Error("boom"));
  wrap(<FilePreview file={file} onClose={() => {}} />);
  expect(await screen.findByText("Could not load this PDF.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
});

test("pages step with previous and next", async () => {
  mode.value = "ok";
  wrap(<FilePreview file={file} onClose={() => {}} />);
  const user = userEvent.setup();
  const prev = () => screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement;
  const next = () => screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement;
  expect(await screen.findByText("1 / 3")).toBeTruthy();
  expect(prev().disabled).toBe(true);
  await user.click(next());
  await user.click(next());
  expect(screen.getByText("3 / 3")).toBeTruthy();
  expect(next().disabled).toBe(true);
  await user.click(prev());
  expect(screen.getByText("2 / 3")).toBeTruthy();
  expect(screen.getByText("page 2")).toBeTruthy();
});

test("a new URL starts again on page 1 with the error cleared", async () => {
  mode.value = "ok";
  api.file.mockImplementation(async ({ id }: { id: string }) => ({
    url: `https://files.test/${id}.pdf`,
  }));
  const ui = (id: string) => (
    <QueryClientProvider client={new QueryClient()}>
      <FilePreview file={{ ...(file as object), id } as never} onClose={() => {}} />
    </QueryClientProvider>
  );
  const view = render(ui("f1"));
  const user = userEvent.setup();
  await screen.findByText("1 / 3");
  await user.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("2 / 3")).toBeTruthy();
  view.rerender(ui("f2"));
  expect(await screen.findByText("1 / 3")).toBeTruthy();
});

test("a PDF file card opens the preview", async () => {
  mode.value = "ok";
  wrap(<FileCard file={file} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Preview r.pdf" }));
  expect(await screen.findByText("1 / 3")).toBeTruthy();
});

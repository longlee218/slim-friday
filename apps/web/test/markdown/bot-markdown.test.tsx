import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BotMarkdown } from "../../src/components/markdown/bot-markdown";

// Hoisted so each test can steer what the lazy `import("shiki" | "mermaid")` returns.
const mocks = vi.hoisted(() => ({
  codeToHtml: vi.fn(),
  render: vi.fn(),
  initialize: vi.fn(),
}));
vi.mock("shiki", () => ({
  codeToHtml: mocks.codeToHtml,
  bundledLanguages: { ts: {}, html: {} },
}));
vi.mock("mermaid", () => ({ default: { initialize: mocks.initialize, render: mocks.render } }));

/** Render markdown inside a router (ticket links navigate in-app). */
function view(text: string) {
  return render(
    <MemoryRouter>
      <BotMarkdown text={text} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // Default: shiki escapes like the real one.
  mocks.codeToHtml.mockImplementation(async (code: string) => {
    const esc = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<pre class="shiki"><code>${esc}</code></pre>`;
  });
  mocks.render.mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.documentElement.removeAttribute("data-theme");
});

test("raw HTML stays text", () => {
  const { container } = view("<script>alert(1)</script><img src=x onerror=alert(1)>");
  expect(container.querySelector("script, img")).toBeNull();
});

test("javascript: links are neutralised", () => {
  view("[x](javascript:alert(1))");
  const href = screen.getByText("x").closest("a")?.getAttribute("href") ?? "";
  expect(href).not.toMatch(/^javascript:/);
});

test("protocol-relative links count as external", () => {
  view("[cdn](//evil.example/x)");
  const a = screen.getByRole("link", { name: "cdn" });
  expect(a.getAttribute("target")).toBe("_blank");
  expect(a.getAttribute("rel")).toBe("noopener noreferrer");
});

test("Copy does not throw without a clipboard", async () => {
  const user = userEvent.setup();
  view("```ts\nconst a = 1;\n```");
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  await user.click(screen.getByRole("button", { name: /Copy/ }));
  expect(screen.getByRole("button", { name: /Copy/ })).not.toBeNull();
});

test("external links open in a new tab safely", () => {
  view("[docs](https://example.com/a)");
  const a = screen.getByRole("link", { name: "docs" });
  expect(a.getAttribute("target")).toBe("_blank");
  expect(a.getAttribute("rel")).toBe("noopener noreferrer");
});

test("tables scroll inside a wrapper", () => {
  const { container } = view("| a | b |\n| - | - |\n| 1 | 2 |");
  expect(container.querySelector("table")?.parentElement?.classList.contains("md-table")).toBe(
    true,
  );
});

test("FRI-21 becomes a ticket link, not inside code", async () => {
  view("See FRI-21 and `FRI-22`");
  const link = screen.getByRole("link", { name: "FRI-21" });
  expect(link.getAttribute("href")).toBe("/tickets/FRI-21");
  expect(link.hasAttribute("target")).toBe(false);
  expect(screen.queryByRole("link", { name: "FRI-22" })).toBeNull();
});

test("[!WARNING] renders a risk callout without the marker", () => {
  const { container } = view("> [!WARNING]\n> Careful here");
  const callout = container.querySelector(".callout");
  expect(callout).not.toBeNull();
  expect(callout?.classList.contains("info")).toBe(false);
  expect(callout?.textContent).toContain("Careful here");
  expect(container.textContent).not.toContain("[!WARNING]");
});

test("[!NOTE] renders an info callout", () => {
  const { container } = view("> [!NOTE]\n> Good to know");
  expect(container.querySelector(".callout.info")).not.toBeNull();
  expect(container.textContent).not.toContain("[!NOTE]");
});

test("a plain quote stays a blockquote", () => {
  const { container } = view("> just a quote");
  expect(container.querySelector("blockquote")).not.toBeNull();
  expect(container.querySelector(".callout")).toBeNull();
});

test("code fence title shows in the header and Copy turns Copied", async () => {
  const user = userEvent.setup();
  view("```ts title=src/a.ts\nconst a = 1;\n```");
  expect(screen.getByText("src/a.ts")).not.toBeNull();
  await user.click(screen.getByRole("button", { name: /Copy/ }));
  expect(await screen.findByRole("button", { name: /Copied/ })).not.toBeNull();
  expect(await navigator.clipboard.readText()).toBe("const a = 1;");
});

test("header shows the language when there is no title, and highlights", async () => {
  const { container } = view("```ts\nconst a = 1;\n```");
  expect(screen.getByText("ts")).not.toBeNull();
  await waitFor(() => expect(container.querySelector("pre.shiki")).not.toBeNull());
  expect(mocks.codeToHtml).toHaveBeenCalledWith(
    "const a = 1;",
    expect.objectContaining({
      lang: "ts",
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    }),
  );
});

test("an unknown language stays a plain pre", async () => {
  const { container } = view("```nope\nhello\n```");
  await new Promise((r) => setTimeout(r, 20));
  expect(mocks.codeToHtml).not.toHaveBeenCalled();
  expect(container.querySelector("pre.shiki")).toBeNull();
  expect(container.querySelector("pre")?.textContent).toContain("hello");
});

test("a fence containing </code><script> stays text after highlighting", async () => {
  const { container } = view("```html\n</code><script>alert(1)</script>\n```");
  await waitFor(() => expect(container.querySelector("pre.shiki")).not.toBeNull());
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("pre.shiki")?.textContent).toContain("<script>alert(1)</script>");
});

test("mermaid fence renders a Diagram placeholder Drawing…", () => {
  view("```mermaid\nflowchart LR\n A-->B\n```");
  expect(screen.getByText("Diagram")).not.toBeNull();
  expect(screen.getByText("Drawing…")).not.toBeNull();
});

test("a drawn diagram injects the SVG and initialises mermaid strictly", async () => {
  mocks.render.mockResolvedValue({ svg: '<svg data-testid="dg"></svg>' });
  view("```mermaid\nflowchart LR\n A-->B\n```");
  expect(await screen.findByTestId("dg")).not.toBeNull();
  expect(mocks.initialize).toHaveBeenCalledWith(
    expect.objectContaining({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: expect.objectContaining({ primaryColor: "#e8edff", darkMode: false }),
    }),
  );
});

test("a mocked svg with script and onload is sanitised", async () => {
  mocks.render.mockResolvedValue({
    svg: '<svg onload="alert(1)"><script>alert(1)</script><rect data-testid="ok" /></svg>',
  });
  const { container } = view("```mermaid\nA-->B\n```");
  await screen.findByTestId("ok");
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("svg")?.hasAttribute("onload")).toBe(false);
});

test("a failed diagram shows the source", async () => {
  mocks.render.mockRejectedValue(new Error("parse error"));
  view("```mermaid\nflowchart LR\n A-->B\n```");
  expect(await screen.findByText("Could not draw this diagram.")).not.toBeNull();
  expect(screen.getByText(/A-->B/)).not.toBeNull();
});

test("a diagram redraws with dark colours when data-theme changes", async () => {
  mocks.render.mockResolvedValue({ svg: "<svg></svg>" });
  view("```mermaid\nflowchart LR\n A-->B\n```");
  await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
  document.documentElement.dataset.theme = "dark";
  await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
  expect(mocks.initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      themeVariables: expect.objectContaining({ primaryColor: "#2c3358", darkMode: true }),
    }),
  );
});

test("two diagrams get different, valid render ids", async () => {
  mocks.render.mockResolvedValue({ svg: "<svg></svg>" });
  view("```mermaid\nA-->B\n```\n\n```mermaid\nC-->D\n```");
  await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
  const [a, b] = mocks.render.mock.calls.map((c) => c[0] as string);
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
});

test("Expand opens the wide sheet", async () => {
  const user = userEvent.setup();
  mocks.render.mockResolvedValue({ svg: '<svg data-testid="dg"></svg>' });
  view("```mermaid\nA-->B\n```");
  await screen.findByTestId("dg");
  await user.click(screen.getByRole("button", { name: /Expand/ }));
  expect(document.querySelector(".sheet.wide")).not.toBeNull();
  // One SVG only while the sheet is open, so element ids stay unique.
  expect(document.querySelectorAll("[data-testid=dg]").length).toBe(1);
});

test("task list items render a check box and mark done items", () => {
  const { container } = view("- [x] done\n- [ ] open");
  expect(container.querySelector("ul.tasks")).not.toBeNull();
  expect(container.querySelectorAll("li.done").length).toBe(1);
  expect(container.querySelectorAll(".cb.on").length).toBe(1);
  expect(container.querySelectorAll("input[type=checkbox]").length).toBe(2);
});

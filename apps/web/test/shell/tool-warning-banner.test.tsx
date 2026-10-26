import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { orpc } from "../../src/api/client";
import { ToolWarningBanner } from "../../src/components/shell/tool-warning-banner";
import { seededClient } from "./fixtures";

/** Renders the banner over a client seeded with `warnings`. */
function setup(warnings: { tool: string; hint: string }[]) {
  const qc = seededClient({});
  qc.setQueryData(orpc.control.toolCheck.queryKey(), warnings);
  return render(
    <QueryClientProvider client={qc}>
      <ToolWarningBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => sessionStorage.clear());

test("an empty list renders no banner", () => {
  const { container } = setup([]);
  expect(container.querySelector(".banner")).toBeNull();
});

test("shows the missing tool and its hint", () => {
  setup([{ tool: "uvx", hint: "brew install uv" }]);
  expect(screen.getByText(/uvx/)).toBeTruthy();
  expect(screen.getByText(/brew install uv/)).toBeTruthy();
});

test("dismiss hides the banner for the session", async () => {
  const { container, unmount } = setup([{ tool: "uvx", hint: "brew install uv" }]);
  await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
  expect(container.querySelector(".banner")).toBeNull();
  unmount();
  const again = setup([{ tool: "uvx", hint: "brew install uv" }]);
  expect(again.container.querySelector(".banner")).toBeNull();
});

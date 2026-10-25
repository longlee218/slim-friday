import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { AutoReviewToggle } from "../../src/components/settings/auto-review-toggle";
import { seededClient } from "../shell/fixtures";

const api = vi.hoisted(() => ({ set: vi.fn(), toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: api.toastError }) }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { config: { permissions: { setAutoReview: api.set } } },
}));

/** Renders the switch over a client seeded with `autoReview`. */
function setup(autoReview: boolean) {
  const qc = seededClient({});
  qc.setQueryData(orpc.config.permissions.get.queryKey(), { autoReview });
  render(
    <QueryClientProvider client={qc}>
      <AutoReviewToggle />
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => vi.clearAllMocks());

test("shows the saved value and turns Auto Review on", async () => {
  api.set.mockResolvedValue({ ok: true });
  const qc = setup(false);
  const sw = screen.getByRole("switch", { name: "Auto Review" });
  expect(sw.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(sw);
  expect(api.set).toHaveBeenCalledWith({ autoReview: true });
  await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
  expect(qc.getQueryData(orpc.config.permissions.get.queryKey())).toEqual({ autoReview: true });
});

test("a refused save puts the switch back and shows a toast", async () => {
  api.set.mockRejectedValue(new Error("settings.yaml is a symlink"));
  setup(true);
  const sw = screen.getByRole("switch", { name: "Auto Review" });
  await userEvent.click(sw);
  await waitFor(() => expect(api.toastError).toHaveBeenCalledWith("settings.yaml is a symlink"));
  expect(sw.getAttribute("aria-checked")).toBe("true");
});

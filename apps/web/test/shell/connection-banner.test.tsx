import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ConnectionBanner } from "../../src/components/shell/connection-banner";

test("banner copy", () => {
  render(<ConnectionBanner state="reconnecting" />);
  expect(
    screen.getByText("Can't reach Friday. Reconnecting… Your messages are kept."),
  ).toBeTruthy();
});

test("offline shows the same copy, resyncing says catching up, live shows nothing", () => {
  const { rerender, container } = render(<ConnectionBanner state="offline" />);
  expect(screen.getByText(/Can't reach Friday/)).toBeTruthy();
  rerender(<ConnectionBanner state="resyncing" />);
  expect(screen.getByText("Catching up…")).toBeTruthy();
  rerender(<ConnectionBanner state="live" />);
  expect(container.querySelector(".banner")).toBeNull();
  expect(container.querySelector("[role=status]")).toBeTruthy();
});

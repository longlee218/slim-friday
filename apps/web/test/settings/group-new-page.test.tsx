import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import { GroupNewPage } from "../../src/components/settings/group-page";
import { seededClient } from "../shell/fixtures";

afterEach(() => {
  window.innerWidth = 1024;
});

const renderPage = () =>
  render(
    <QueryClientProvider client={seededClient({})}>
      <MemoryRouter>
        <GroupNewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

test("desktop: a new group's avatar can be picked before it is saved", () => {
  renderPage();
  expect(screen.getByRole("heading", { name: "New group" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change avatar" })).toBeTruthy();
});

test("phone: the face is there without a second heading", () => {
  window.innerWidth = 390;
  renderPage();
  expect(screen.queryByRole("heading", { name: "New group" })).toBeNull();
  expect(screen.getByRole("button", { name: "Change avatar" })).toBeTruthy();
});

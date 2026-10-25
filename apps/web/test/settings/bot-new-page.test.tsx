import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import { BotNewPage } from "../../src/components/settings/bot-page";
import { seededClient } from "../shell/fixtures";

afterEach(() => {
  window.innerWidth = 1024;
});

const renderPage = () =>
  render(
    <QueryClientProvider client={seededClient({})}>
      <MemoryRouter>
        <BotNewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

test("desktop: the page head names the new bot", () => {
  renderPage();
  expect(screen.getByRole("heading", { name: "New bot" })).toBeTruthy();
});

test("phone: the nav bar names the page, so there is no second heading", () => {
  window.innerWidth = 390;
  renderPage();
  expect(screen.queryByRole("heading", { name: "New bot" })).toBeNull();
  expect(screen.getByText("New bot", { selector: ".ios-nav .ttl" })).toBeTruthy();
});

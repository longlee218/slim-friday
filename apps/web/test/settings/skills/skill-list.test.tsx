import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import { SkillList } from "../../../src/components/settings/skills/skill-list";
import { seededClient } from "../../shell/fixtures";

afterEach(() => {
  window.innerWidth = 1024;
});

test("phone: the nav bar's plus opens Install skill (the page head is hidden there)", async () => {
  window.innerWidth = 390;
  render(
    <QueryClientProvider client={seededClient({})}>
      <MemoryRouter>
        <SkillList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const nav = document.querySelector(".ios-nav") as HTMLElement;
  const plus = within(nav).getByRole("button", { name: "Install skill" });
  await userEvent.click(plus);
  expect(await screen.findByRole("heading", { name: "Install skill" })).toBeTruthy();
});

import { expect, test } from "@playwright/test";
import { signInFirstTime } from "./helpers";

test("sign in with a passkey, chat, upload, answer an approval, run a ticket, open activity", async ({
  page,
  context,
}) => {
  await signInFirstTime(page, context);
  // A fresh session: only the passkey can get back in.
  await context.clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  // Leaving /login before the passkey answer lands would cancel the sign-in.
  await page.waitForURL((u) => u.pathname === "/");
  await page.goto("/c/bot:friday");
  await page.getByRole("textbox", { name: "Message" }).fill("hello");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Echo: hello")).toBeVisible();
  await expect(page.getByText(/Worked for \d+s · 1 step/)).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles("e2e/fixtures/pixel.png");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Got 1 file(s).")).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("approve the push");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(/You allowed once:/)).toBeVisible();
  await expect(page.getByText("Pushed.")).toBeVisible();

  // Tickets: create one, move it to Doing from the drawer, read the change in its history.
  await page.goto("/tickets");
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Title").fill("Smoke ticket");
  await page.getByRole("button", { name: "Create ticket" }).click();
  const card = page.locator(".tcard", { hasText: "Smoke ticket" });
  await expect(card).toBeVisible();
  // Creating opens the new ticket's drawer (a click on its card would close it again).
  await expect(page).toHaveURL(/\?t=FRI-\d+/);
  await page.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Doing" }).click();
  await page.getByRole("button", { name: "Open full page (↩)" }).click();
  await expect(page.getByText(/moved it to Doing/)).toBeVisible();

  // Activity: the sessions table is there.
  await page.goto("/ops");
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
});

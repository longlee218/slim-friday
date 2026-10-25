import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, expect, type Page } from "@playwright/test";

/** Where `apps/friday/scripts/e2e-engine.ts` writes its temp AGENT_HOME. */
const HOME_FILE = join(tmpdir(), "friday-e2e-home.txt");

/** The engine's temp AGENT_HOME. */
export const engineHome = (): string => readFileSync(HOME_FILE, "utf8").trim();

/** Lines of the owner-links log so far (0 when the file does not exist yet). */
function linkLines(agentHome: string): string[] {
  try {
    return readFileSync(join(agentHome, "logs", "owner-links.log"), "utf8")
      .trim()
      .split("\n");
  } catch {
    return [];
  }
}

/**
 * The newest magic link: the last line of `<agentHome>/logs/owner-links.log` is `<ISO time> <url>`.
 * `skip` is how many lines existed before the request: the log is shared by the whole run, so an older
 * (used) link must not be returned. Polls until a newer line appears.
 */
export async function readOwnerLink(agentHome: string, skip = 0): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const lines = linkLines(agentHome);
    const url = lines.length > skip ? lines[lines.length - 1]?.split(" ")[1] : undefined;
    if (url) return url;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no owner link was written");
}

/** First sign-in: magic link from the host log, then a passkey made by the virtual authenticator. */
export async function signInFirstTime(page: Page, context: BrowserContext): Promise<void> {
  await context.credentials.install();
  const before = linkLines(engineHome()).length;
  await page.goto("/login");
  await page.getByRole("link", { name: "Get a sign-in link" }).click();
  await page.getByRole("textbox", { name: "Your email" }).fill("owner@example.test");
  await page.getByRole("button", { name: "Send link" }).click();
  await page.goto(await readOwnerLink(engineHome(), before));
  await page.waitForURL("**/setup-passkey");
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page.getByRole("heading", { name: "You're in" })).toBeVisible();
}

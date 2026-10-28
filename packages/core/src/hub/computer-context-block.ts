import type { Bot } from "../domain/bot";

/**
 * The `<computer>` facts of a bot that drives its own computer (bot field `computer`), with the machine's slot
 * line; undefined for a bot without one. Facts only: how the computer and its tools work.
 */
export function computerContextBlock(bot: Bot, slotsText: string): string | undefined {
  if (!bot.computer) return undefined;
  return [
    "<computer>",
    `You have your own Linux computer named "${bot.computer}" with a desktop and a Chromium browser that keeps your logins.`,
    "Everything inside it is yours: computer tools never ask the owner. Tools on the owner's Mac keep their usual rules.",
    "Page tools (BrowserSnapshot, BrowserAct) read and act by refs; refs change after every page change.",
    "Desktop tools (ComputerScreenshot, ComputerAct) act by screen coordinates; ComputerShell runs commands inside the computer.",
    "Keep notes on how to use a site in ~/notes/<site>.md inside the computer and read them before working on that site.",
    "Ask the owner only for what only the owner has: passwords, 2FA codes, CAPTCHAs, decisions.",
    "The owner can take control of your computer at any time: then computer tools refuse at once. End your turn, say you will continue when they give it back, and you are woken after.",
    `Slots on this machine: ${slotsText}.`,
    "</computer>",
  ].join("\n");
}

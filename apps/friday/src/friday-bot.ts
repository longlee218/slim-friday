import type { Bot } from "@friday/core";

/** Id of the shipped bot that builds other bots and groups. */
export const FRIDAY_BOT_ID = "friday";

/**
 * Fill the real dirs into the Friday bot's instructions (`<config dir>`, `<template dir>`).
 * Any other bot is returned unchanged.
 */
export function withFridayDirs(bot: Bot, dirs: { configDir: string; templatesDir: string }): Bot {
  if (bot.id !== FRIDAY_BOT_ID) return bot;
  return {
    ...bot,
    instructions: bot.instructions
      .replaceAll("<config dir>", dirs.configDir)
      .replaceAll("<template dir>", dirs.templatesDir),
  };
}

/**
 * Dirs the app grants to the Friday bot only: read on the templates. It has no write grant: the config dir is written
 * only through the `BotDesign` tool, which runs in the engine and checks every field.
 */
export function fridayExtraDirs(templatesDir: string) {
  return (b: Bot): { write: string[]; read: string[] } =>
    b.id === FRIDAY_BOT_ID ? { write: [], read: [templatesDir] } : { write: [], read: [] };
}

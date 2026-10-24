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

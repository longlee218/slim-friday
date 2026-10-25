import { clipResult } from "./clip-result";

/**
 * Tool result with one text block, clipped at 12 000 chars (every Friday tool builds its result here);
 * `isError` marks a refused or failed call.
 */
export const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text: clipResult(text) }],
  ...(isError && { isError: true as const }),
});

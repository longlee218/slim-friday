/** Tool result with one text block; `isError` marks a refused or failed call. */
export const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError && { isError: true as const }),
});

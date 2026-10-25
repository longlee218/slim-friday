/**
 * The `ENABLE_TOOL_SEARCH` of the SDK child for a `limits.toolSearch` value: `on` leaves it unset (the SDK default,
 * even when the owner's shell sets it), `off` is `false`, `auto:N` passes through.
 */
export function toolSearchEnv(mode: string): Record<string, string | undefined> {
  return { ENABLE_TOOL_SEARCH: mode === "on" ? undefined : mode === "off" ? "false" : mode };
}

/**
 * The built-in tools with `ToolSearch` added (tool search needs it listed). An intro run and a run with search `off`
 * keep the list as it is.
 */
export function withToolSearch(builtIn: string[], mode: string, intro: boolean): string[] {
  return intro || mode === "off" || builtIn.includes("ToolSearch")
    ? builtIn
    : [...builtIn, "ToolSearch"];
}

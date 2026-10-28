/** Description the model reads for `BrowserAct`. */
export const BROWSER_ACT_DESCRIPTION =
  "Run 1 to 20 steps on the browser page, in order: click (ref), type (ref, text, optional submit), key, scroll (dy, optional ref), wait (ms). Refs come from the latest BrowserSnapshot and change after every page change. The batch holds the computer's exclusive input lease and stops at the first failing step.";

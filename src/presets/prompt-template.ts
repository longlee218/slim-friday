import Mustache from "mustache";

/* Prompt templates (`prompt.md`, partials): Mustache, logic-less. Text is a prompt, not HTML, so nothing is escaped. */
Mustache.escape = (text: string) => text;

/** Values a template may name: `{{tool.X}}`, `{{limit.X}}`, `{{vars.X}}`. */
export type PromptView = Record<string, Record<string, string | number>>;

type Token = [string, string, number, number, Token[]?];

/** Every variable and partial name a parsed template uses (sections included). */
function used(tokens: Token[], out: { vars: Set<string>; partials: Set<string> }): void {
  for (const t of tokens) {
    if (t[0] === "name" || t[0] === "&" || t[0] === "#" || t[0] === "^") out.vars.add(t[1]);
    if (t[0] === ">") out.partials.add(t[1]);
    if (t[4]) used(t[4], out);
  }
}

/** The value at a dotted path of the view, or undefined. */
const lookup = (view: PromptView, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], view);

/**
 * Render one template. An unknown variable or partial throws (naming `source`): a typo must refuse the start, not render
 * as empty text. Partials get a closing newline so a standalone `{{> name}}` line keeps the blank line after it.
 */
export function renderPrompt(
  source: string,
  template: string,
  view: PromptView,
  partials: Record<string, string>,
): string {
  const seen = { vars: new Set<string>(), partials: new Set<string>() };
  used(Mustache.parse(template) as Token[], seen);
  for (const v of seen.vars)
    if (lookup(view, v) === undefined) throw new Error(`${source}: unknown variable {{${v}}}`);
  const withNewline: Record<string, string> = {};
  for (const p of seen.partials) {
    if (partials[p] === undefined) throw new Error(`${source}: unknown partial {{> ${p}}}`);
    withNewline[p] = `${partials[p]}\n`;
  }
  return Mustache.render(template, view, withNewline);
}

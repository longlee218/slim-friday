/* `gh` is open to the agent (it opens PRs and merges with the owner's login); only what destroys a repo or reveals the
   login token is denied. Pure helpers shared by the parsed path and the raw-text pass of bash-policy.ts. */

/** True when the DELETE method is chosen: `-X DELETE`, `-XDELETE`, `--method DELETE`, `--method=delete` (any case). */
function deleteMethod(args: string[]): boolean {
  return args.some(
    (a, i) =>
      /^-X\s*delete$/i.test(a) ||
      /^--method=delete$/i.test(a) ||
      (/^(-X|--method)$/i.test(a) && /^delete$/i.test(args[i + 1] ?? "")),
  );
}

/** Reason when `gh <args>` must not run, else undefined: `repo delete`, `api` with DELETE, `auth token` / `auth status -t`. */
export function ghDenial(args: string[]): string | undefined {
  const [a, b] = args.filter((x) => !x.startsWith("-"));
  if (a === "repo" && b === "delete") return "gh repo delete is blocked";
  if (a === "api" && deleteMethod(args)) return "gh api DELETE is blocked";
  if (a === "auth" && b === "token") return "printing the gh token is blocked";
  if (
    a === "auth" &&
    b === "status" &&
    args.some((x) => /^(--show-token|-[a-z]*t[a-z]*)$/i.test(x))
  )
    return "printing the gh token is blocked";
  return undefined;
}

/** Raw-text forms of the same denials (a line the tokenizer cannot split). */
export const RAW_GH_DENY: RegExp[] = [
  /\bgh\b[^\n]*\brepo\s+delete\b/,
  /\bgh\b[^\n]*\bapi\b[^\n]*(-X\s*|--method[ =]\s*)delete\b/i,
  /\bgh\b[^\n]*\bauth\s+token\b/,
  /\bgh\b[^\n]*\bauth\s+status\b[^\n]*(\s-[a-z]*t\b|--show-token)/i,
];

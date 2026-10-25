import { mcpServerOf } from "./taint-policy";

/** Verbs that change something (spec §6.14, Rakazo R§16 step 2). A tool name with one of these as a token is consequential. */
const CONSEQUENTIAL_VERBS: ReadonlySet<string> = new Set([
  "accept", "add", "approve", "archive", "book", "buy", "cancel", "charge", "create", "delete",
  "deploy", "edit", "invite", "merge", "move", "pay", "post", "publish", "purchase", "push",
  "remove", "rename", "reply", "send", "set", "share", "submit", "transfer", "update", "upload",
  "write",
]); // biome-ignore format: word list

/** Verbs that only look (spec §6.14; get/list/search/find/read are Rakazo's, fetch/query/describe/show are Friday's addition). */
const READ_VERBS: ReadonlySet<string> = new Set([
  "get", "list", "search", "find", "read", "fetch", "query", "describe", "show",
]); // biome-ignore format: word list

/** Words that join two actions in one tool (`get_and_delete`): the tool does more than its first verb says. */
const COMPOUND_WORDS: ReadonlySet<string> = new Set(["and", "or", "then"]);

/** Servers (or name words) of mail tools; `mail` also matches `email`, `gmail` and `smtp` by substring. */
const MAIL_WORDS = ["mail", "outlook", "smtp"];
/** Verbs that send a mail. */
const MAIL_VERBS: ReadonlySet<string> = new Set(["send", "reply", "forward"]);
/** Servers (or name words) of shops and payment providers. */
const PURCHASE_SERVERS = ["stripe", "shopify", "paypal", "square"];
/** Verbs that spend money. */
const PURCHASE_VERBS: ReadonlySet<string> = new Set([
  "pay", "charge", "checkout", "buy", "purchase", "order", "refund",
]); // biome-ignore format: word list

/**
 * The words of a tool's own name, lower case: the `mcp__<server>__` prefix is dropped, then the name is
 * split on `_`, `-` and camelCase boundaries (`sendEmail` -> send, email).
 */
function tokens(tool: string): string[] {
  const server = mcpServerOf(tool);
  const own = server ? tool.slice("mcp__".length + server.length + 2) : tool;
  return own
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * How risky an external MCP tool is by its name alone. A token must equal a verb (`postgres` is not `post`).
 * A consequential verb wins; a compound word (`_and_`) next to any known verb also counts as consequential;
 * only read verbs is `read`; anything else is `unknown`.
 */
export function nameRisk(tool: string): "consequential" | "read" | "unknown" {
  const words = tokens(tool);
  if (words.some((w) => CONSEQUENTIAL_VERBS.has(w))) return "consequential";
  const hasRead = words.some((w) => READ_VERBS.has(w));
  if (hasRead && words.some((w) => COMPOUND_WORDS.has(w))) return "consequential";
  return hasRead ? "read" : "unknown";
}

/**
 * The category an owner rule can name (spec §6.14): `email` (a mail tool that sends, replies or forwards) or
 * `purchase` (a verb that spends money, or a consequential call on a shop or payment server).
 * A read-only name has no category.
 */
export function categoryOf(tool: string, server: string): "email" | "purchase" | undefined {
  const risk = nameRisk(tool);
  if (risk === "read") return undefined;
  const words = tokens(tool);
  const where = [server.toLowerCase(), ...words];
  const mentions = (list: string[]) => where.some((w) => list.some((x) => w.includes(x)));
  if (words.some((w) => MAIL_VERBS.has(w)) && mentions(MAIL_WORDS)) return "email";
  if (words.some((w) => PURCHASE_VERBS.has(w))) return "purchase";
  if (risk === "consequential" && mentions(PURCHASE_SERVERS)) return "purchase";
  return undefined;
}

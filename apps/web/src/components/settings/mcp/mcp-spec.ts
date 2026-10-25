import {
  McpNameSchema,
  type McpServerDto,
  type McpServerSpecDto,
  McpServerSpecDtoSchema,
} from "@friday/contracts";
import type { FieldErrors } from "../use-form-state";

/** One name and value row (an environment variable or a header). */
export interface Pair {
  k: string;
  v: string;
}

/**
 * What the MCP form edits. `args` is one line (split on spaces on save); `env` belongs to a
 * local command and `headers` to an HTTP server. Their keys match the server's `data.field`.
 */
export interface McpFormValue {
  type: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  env: Pair[];
  headers: Pair[];
  /** HTTP only: Friday signs in to the server (OAuth) and holds the tokens. */
  oauth: boolean;
  /** OAuth scopes, one line split on spaces or commas; empty = the server's defaults. */
  scopes: string;
}

/** The values of a server that does not exist yet. */
export const NEW_MCP: McpFormValue = {
  type: "stdio",
  command: "",
  args: "",
  url: "",
  env: [],
  headers: [],
  oauth: false,
  scopes: "",
};

const toPairs = (m?: Record<string, string>): Pair[] =>
  Object.entries(m ?? {}).map(([k, v]) => ({ k, v }));

const toMap = (p: Pair[]): Record<string, string> =>
  Object.fromEntries(p.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v]));

const isAuthorization = (k: string): boolean => k.trim().toLowerCase() === "authorization";

/** The form value of a server the engine returned. */
export function fromServer(s: McpServerDto): McpFormValue {
  return s.type === "stdio"
    ? {
        ...NEW_MCP,
        type: "stdio",
        command: s.command,
        args: (s.args ?? []).join(" "),
        env: toPairs(s.env),
      }
    : {
        ...NEW_MCP,
        type: "http",
        url: s.url,
        headers: toPairs(s.headers),
        oauth: !!s.oauth,
        scopes: (s.oauth?.scopes ?? []).join(" "),
      };
}

/** The contract's spec for a form value (empty arguments, env and headers are left out). */
export function toSpec(v: McpFormValue): McpServerSpecDto {
  if (v.type === "http") {
    // With OAuth on, an Authorization header would clash with the token Friday injects.
    const headers = toMap(v.oauth ? v.headers.filter((h) => !isAuthorization(h.k)) : v.headers);
    const scopes = v.scopes.split(/[\s,]+/).filter(Boolean);
    return {
      type: "http",
      url: v.url.trim(),
      ...(Object.keys(headers).length && { headers }),
      ...(v.oauth && { oauth: scopes.length ? { scopes } : {} }),
    };
  }
  const args = v.args.split(/\s+/).filter(Boolean);
  const env = toMap(v.env);
  return {
    type: "stdio",
    command: v.command.trim(),
    ...(args.length && { args }),
    ...(Object.keys(env).length && { env }),
  };
}

/** Validates with the contract's spec schema; each issue lands on the form field it names. */
export function validateMcp(v: McpFormValue): FieldErrors<McpFormValue> {
  const errors: FieldErrors<McpFormValue> = {};
  const parsed = McpServerSpecDtoSchema.safeParse(toSpec(v));
  if (parsed.success) return errors;
  for (const i of parsed.error.issues) {
    const key = i.path[0] as keyof McpFormValue | undefined;
    if (key && !errors[key]) errors[key] = i.message;
  }
  return errors;
}

/** A server name: the contract's rule. */
export const NAME_HELP = "Lowercase letters, digits and dashes; start with a letter; up to 32.";

/** True when `name` is a valid server name. */
export const validName = (name: string): boolean => McpNameSchema.safeParse(name).success;

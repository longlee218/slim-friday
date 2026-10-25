/**
 * Sites the owner named (spec §6.10 "Sites the owner named"): registrable domains of the URLs and bare
 * hostnames in the owner's message texts of a run. A tainted run may fetch these without a card.
 *
 * Core has no dependencies, so the registrable domain (eTLD+1 by the Public Suffix List, private section
 * included) comes from the app as a `RegistrableDomain` function (the gate's deps). Without one, core uses
 * `exactHost`: the whole host name, which never widens a site (only adds cards).
 */

/**
 * The registrable domain of a host name by the Public Suffix List; undefined when the host is itself a public
 * suffix (e.g. `s3.amazonaws.com`, `fly.dev`) or its suffix is unknown. An IP address is returned as is.
 */
export type RegistrableDomain = (host: string) => string | undefined;

/** The fallback `RegistrableDomain`: the lower-case host name, no trailing dot; never shared by two hosts. */
export const exactHost: RegistrableDomain = (host) =>
  host.toLowerCase().replace(/\.$/, "") || undefined;

/** URLs with a scheme; the host is read with `URL`. */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
/**
 * Bare hostnames: two or more labels (any script's letters and digits) ending in a letters-only label. Not
 * part of a longer token on either side, so `bücher.de` is one host (never `cher.de`); it is read with `URL`,
 * which turns it into its ASCII (punycode) form like a URL's host.
 */
const HOST_RE =
  /(?<![\p{L}\p{N}_.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,24}(?![\p{L}\p{N}_-])/gu;

/**
 * Last labels that are real top-level domains but far more often file extensions (`README.md`, `setup.sh`,
 * `main.cc`): a bare name ending in one is never a site. A full URL with a scheme is still counted. Short list
 * on purpose; names ending in non-TLD extensions (`.json`, `.ts`, `.yaml`) are dropped by the suffix check.
 */
const FILE_EXTENSION_TLDS = new Set([
  "md",
  "sh",
  "py",
  "rs",
  "cc",
  "so",
  "zip",
  "mov",
  "pl",
  "pm",
  "ps",
  "in",
  "cs",
  "js",
  "ts",
  "rb",
  "txt",
  "json",
  "yaml",
  "yml",
  "tf",
  "mk",
  "ml",
  "ai",
  "java",
  "pub",
  "pro",
]);

/** The hostname of a URL string; undefined when it is not an http(s) URL. */
export function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registrable domains of the URLs and bare hostnames in `texts` (the owner's message texts of the run). URLs
 * are cut out before bare names are read, so a host inside a URL's path or query is never a site. A bare name
 * counts only with a known public suffix (`domainOf` gives a domain) and a last label not in the file list.
 */
export function ownerSites(texts: string[], domainOf: RegistrableDomain = exactHost): Set<string> {
  const sites = new Set<string>();
  const add = (d: string | undefined) => d && sites.add(d);
  for (const text of texts) {
    for (const m of text.matchAll(URL_RE)) {
      const host = hostOf(m[0]);
      if (host) add(domainOf(host));
    }
    for (const m of text.replace(URL_RE, " ").matchAll(HOST_RE)) {
      const last = m[0].split(".").at(-1)?.toLowerCase() ?? "";
      const host = hostOf(`http://${m[0]}`);
      if (host && !FILE_EXTENSION_TLDS.has(last)) add(domainOf(host));
    }
  }
  return sites;
}

/**
 * Sites the owner named (spec §6.10 "Sites the owner named"): registrable domains of the URLs and bare
 * hostnames in the owner's message texts of a run. A tainted run may fetch these without a card.
 *
 * Limitation: core has no dependencies, so the registrable domain (eTLD+1) comes from a short built-in list of
 * multi-label public suffixes, not the full Public Suffix List. A host under a suffix missing from the list
 * collapses to its last two labels (e.g. `a.example.xyz.zz` -> `xyz.zz`), so two owners of one unlisted shared
 * suffix count as one site. The list holds the common country second levels and shared hosting suffixes.
 */

/** Public suffixes with more than one label (country second levels and shared hosting); see the limitation above. */
const MULTI_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.kr",
  "com.br",
  "com.cn",
  "com.hk",
  "com.sg",
  "com.tw",
  "com.vn",
  "edu.vn",
  "gov.vn",
  "co.in",
  "co.za",
  "com.mx",
  "com.tr",
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "herokuapp.com",
  "blogspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "s3.amazonaws.com",
  "ngrok.io",
  "ngrok-free.app",
]);

/** An IPv4 address (kept whole: it has no registrable domain). */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** URLs with a scheme; the host is read with `URL`. */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
/** Bare hostnames: two or more labels ending in a letters-only label (also matches some file names; harmless). */
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;

/**
 * The registrable domain of a hostname: lower case, no trailing dot, the label before a known multi-label
 * suffix plus that suffix, else the last two labels. An IP address or a one-label host is returned as is.
 */
export function registrableDomain(host: string): string {
  const h = host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (IPV4.test(h) || h.includes(":")) return h;
  const labels = h.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  const lastThree = labels.slice(-3).join(".");
  // A three-label shared suffix (s3.amazonaws.com) needs one more label in front.
  if (MULTI_SUFFIXES.has(lastThree)) return labels.slice(-4).join(".");
  return MULTI_SUFFIXES.has(lastTwo) ? lastThree : lastTwo;
}

/** The hostname of a URL string; undefined when it is not an http(s) URL. */
export function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** Registrable domains of the URLs and bare hostnames in `texts` (the owner's message texts of the run). */
export function ownerSites(texts: string[]): Set<string> {
  const sites = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(URL_RE)) {
      const host = hostOf(m[0]);
      if (host) sites.add(registrableDomain(host));
    }
    for (const m of text.matchAll(HOST_RE)) sites.add(registrableDomain(m[0]));
  }
  return sites;
}

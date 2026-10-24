/** Private IPv4 ranges a plain-http Honcho may live in (plus loopback). */
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];
/** A dotted-quad IPv4 literal (a DNS name such as `10.evil.com` is not one). */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for `localhost`, a loopback, or a private IP literal. */
function isLocalHost(host: string): boolean {
  if (host === "localhost" || host === "[::1]") return true;
  if (/^\[(fc|fd)[0-9a-f]{2}:/i.test(host)) return true;
  return IPV4.test(host) && PRIVATE_V4.some((re) => re.test(host));
}

/**
 * Problem with a Honcho base URL, or undefined when it may be used: `https://` to any host, `http://` only to
 * localhost, a loopback or a private IP literal (a plain-http public host would send the key in clear).
 */
export function checkHonchoUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  if (u.protocol === "https:") return undefined;
  if (u.protocol !== "http:") return `only http or https: ${url}`;
  return isLocalHost(u.hostname)
    ? undefined
    : `plain http only to localhost or a private address: ${url}`;
}

/** True when the URL points at this machine or a private network (a key is optional there). */
export function isPrivateHonchoUrl(url: string): boolean {
  try {
    return isLocalHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

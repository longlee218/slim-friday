import { isIP } from "node:net";

/**
 * WebAuthn relying-party id for a web origin: the host, minus its first label when the host has
 * three or more labels. `localhost` and IP hosts stay as they are.
 */
export function rpIdFor(webOrigin: string): string {
  const host = new URL(webOrigin).hostname;
  if (host === "localhost" || isIP(host.replace(/^\[|\]$/g, "")) !== 0) return host;
  const labels = host.split(".");
  return labels.length >= 3 ? labels.slice(1).join(".") : host;
}

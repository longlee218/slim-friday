import type { RegistrableDomain } from "../../src";

/** Public suffixes of the fake list (a tiny stand-in for the Public Suffix List, private section included). */
const SUFFIXES = new Set([
  "de",
  "com",
  "test",
  "sh",
  "md",
  "cc",
  "uk",
  "co.uk",
  "dev",
  "fly.dev",
  "io",
  "github.io",
]);

/**
 * A fake `RegistrableDomain`: the label before the longest known suffix plus that suffix; undefined when the
 * host is a suffix itself or no suffix is known. IPv4 kept whole.
 */
export const fakeRegistrableDomain: RegistrableDomain = (host) => {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h;
  const labels = h.split(".");
  for (let i = 0; i < labels.length; i++) {
    if (SUFFIXES.has(labels.slice(i).join(".")))
      return i === 0 ? undefined : labels.slice(i - 1).join(".");
  }
  return undefined;
};

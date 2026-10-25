import type { RegistrableDomain } from "@friday/core";
import { parse } from "tldts";

/**
 * The registrable domain of a host by the Public Suffix List, private section included, so shared hosts
 * (`myapp.fly.dev`, `me.github.io`, `x.s3.us-west-2.amazonaws.com`, `foo.r2.dev`) are separate sites. Undefined
 * when the host is itself a public suffix (`s3.amazonaws.com`, `fly.dev`) or its suffix is not in the list
 * (`localhost`, `readme.unknownzz`): such a host is never a site the owner named. An IP address is kept whole.
 */
export const registrableDomain: RegistrableDomain = (host) => {
  const p = parse(host, { allowPrivateDomains: true });
  if (p.isIp) return host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!(p.isIcann || p.isPrivate)) return undefined;
  return p.domain ?? undefined;
};

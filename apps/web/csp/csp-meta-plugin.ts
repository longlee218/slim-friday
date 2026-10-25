import type { Plugin } from "vite";
import { buildCsp } from "./csp.ts";

// Injects the CSP as the first element of <head> in production builds only: Vite dev serves
// inline scripts (the React refresh preamble) that this policy would block.
export function cspMetaPlugin(env: Record<string, string>): Plugin {
  return {
    name: "friday-csp-meta",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: () => [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: buildCsp({
              apiUrl: env.VITE_API_URL,
              r2Origin: env.VITE_R2_ORIGIN,
              cdnOrigin: env.VITE_CDN_ORIGIN,
            }),
          },
          injectTo: "head-prepend",
        },
      ],
    },
  };
}

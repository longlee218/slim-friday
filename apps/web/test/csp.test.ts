import { expect, test } from "vitest";
import { checkDist } from "../csp/check-dist";
import { buildCsp } from "../csp/csp";

const api = "https://friday-api.example.com";
const r2 = "https://acct.r2.cloudflarestorage.com";
const cdn = "https://cdn.example.com";

const directives = (csp: string) =>
  Object.fromEntries(csp.split("; ").map((p) => [p.split(" ")[0], p]));

test("buildCsp refuses a missing or non-https origin", () => {
  expect(() => buildCsp({ apiUrl: undefined, r2Origin: r2 })).toThrow("VITE_API_URL");
  expect(() => buildCsp({ apiUrl: api, r2Origin: "" })).toThrow("VITE_R2_ORIGIN");
  expect(() => buildCsp({ apiUrl: "http://friday-api.example.com", r2Origin: r2 })).toThrow(
    "https",
  );
  expect(() => buildCsp({ apiUrl: "not a url", r2Origin: r2 })).toThrow("VITE_API_URL");
});

test("buildCsp allows http only for localhost and 127.0.0.1", () => {
  expect(buildCsp({ apiUrl: "http://127.0.0.1:8787", r2Origin: r2 })).toContain(
    "http://127.0.0.1:8787",
  );
});

test("buildCsp lists the API and R2 origins and nothing inline for scripts", () => {
  const d = directives(buildCsp({ apiUrl: `${api}/`, r2Origin: `${r2}/` }));
  expect(d["default-src"]).toBe("default-src 'self'");
  expect(d["script-src"]).toBe("script-src 'self' 'wasm-unsafe-eval'");
  expect(d["style-src"]).toBe("style-src 'self' 'unsafe-inline'");
  expect(d["connect-src"]).toBe(`connect-src 'self' ${api} ${r2}`);
  expect(d["img-src"]).toBe(`img-src 'self' data: blob: ${r2}`);
  expect(d["worker-src"]).toBe("worker-src 'self'");
  expect(d["manifest-src"]).toBe("manifest-src 'self'");
  expect(d["font-src"]).toBe("font-src 'self'");
  expect(d["object-src"]).toBe("object-src 'none'");
  expect(d["base-uri"]).toBe("base-uri 'self'");
});

test("buildCsp appends the optional CDN origin to connect-src and img-src", () => {
  const d = directives(buildCsp({ apiUrl: api, r2Origin: r2, cdnOrigin: `${cdn}/` }));
  expect(d["connect-src"]).toBe(`connect-src 'self' ${api} ${r2} ${cdn}`);
  expect(d["img-src"]).toBe(`img-src 'self' data: blob: ${r2} ${cdn}`);
  expect(buildCsp({ apiUrl: api, r2Origin: r2, cdnOrigin: "" })).not.toContain("cdn");
  expect(buildCsp({ apiUrl: api, r2Origin: r2 })).not.toContain("cdn");
  const http = { apiUrl: api, r2Origin: r2, cdnOrigin: "http://cdn.example.com" };
  expect(() => buildCsp(http)).toThrow("https");
  expect(() => buildCsp(http)).toThrow("VITE_CDN_ORIGIN");
});

test("checkDist refuses an inline script, an inline handler and a missing or late meta CSP", () => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`;
  expect(
    checkDist(`<head>${meta}<script type="module" src="/assets/a.js"></script></head>`),
  ).toEqual([]);
  expect(checkDist(`<head>${meta}<script>alert(1)</script></head>`)).toContain("inline script");
  expect(checkDist(`<head>${meta}</head><body onload="x()">`)).toContain("inline event handler");
  expect(checkDist(`<head><script src="/a.js"></script></head>`)).toContain("meta CSP missing");
  expect(checkDist(`<head><script src="/a.js"></script>${meta}</head>`)).toContain(
    "meta CSP not first in head",
  );
});

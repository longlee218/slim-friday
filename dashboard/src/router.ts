import { useEffect, useState } from "react";

/** Hash routes keep deep links working with no server routing: #/goals/<id>?run=<turnId>. */
export interface Route {
  parts: string[];
  query: URLSearchParams;
}

function read(): Route {
  const [path = "", q = ""] = window.location.hash.replace(/^#\/?/, "").split("?");
  return { parts: path.split("/").filter(Boolean), query: new URLSearchParams(q) };
}

/** Current route, updated on hash change. */
export function useRoute(): Route {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** Build an href: link("goals", id) -> "#/goals/<id>"; optional query. */
export function link(...parts: (string | Record<string, string | null>)[]): string {
  const path = parts.filter((p): p is string => typeof p === "string").join("/");
  const q = parts.find((p): p is Record<string, string | null> => typeof p === "object");
  const params = q
    ? new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => e[1] != null))
    : null;
  return `#/${path}${params && params.size ? `?${params}` : ""}`;
}

/** Navigate in code (row clicks). */
export function go(href: string): void {
  window.location.hash = href.slice(1);
}

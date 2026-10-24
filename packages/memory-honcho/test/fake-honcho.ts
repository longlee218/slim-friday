/** An in-memory Honcho v3 behind a `fetch`: workspaces, peers, conclusions (word-overlap search). */
export function fakeHoncho() {
  const peers = new Set<string>();
  const conclusions: { id: string; content: string; observer_id: string; observed_id: string }[] =
    [];
  const queries: { filters: { observer_id: string; observed_id: string } }[] = [];
  let next = 1;
  let failPeers = 0;
  /** While set, peer calls wait for it (or for their request's abort). */
  let held: Promise<void> | undefined;
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1),
    );
  const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith("/peers")) {
      if (held) {
        const gate = held;
        await new Promise<void>((resolve, reject) => {
          if (init.signal?.aborted) return reject(init.signal.reason);
          gate.then(resolve);
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      if (failPeers > 0) {
        failPeers--;
        return reply({}, 503);
      }
      peers.add(body.id);
      return reply({ id: body.id });
    }
    if (path === "/v3/workspaces") return reply({ id: body.id });
    if (path.endsWith("/conclusions/query")) {
      queries.push(body);
      const q = words(body.query);
      const hits = conclusions
        .filter(
          (c) =>
            c.observer_id === body.filters.observer_id &&
            c.observed_id === body.filters.observed_id,
        )
        .map((c) => ({ c, n: [...words(c.content)].filter((w) => q.has(w)).length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, body.top_k)
        .map((x) => x.c);
      return reply(hits);
    }
    if (path.endsWith("/conclusions") && init.method === "post") {
      for (const c of body.conclusions) conclusions.push({ id: `c${next++}`, ...c });
      return reply([]);
    }
    const del = /\/conclusions\/([^/]+)$/.exec(path);
    if (del && init.method === "delete") {
      const i = conclusions.findIndex((c) => c.id === del[1]);
      if (i < 0) return reply({}, 404);
      conclusions.splice(i, 1);
      return reply({});
    }
    return reply({}, 404);
  }) as typeof fetch;
  return {
    fetch: fetchFn,
    peers,
    conclusions,
    queries,
    /** Make the next `n` peer calls fail with 503. */
    failNextPeers: (n: number) => {
      failPeers = n;
    },
    /** Hold every peer call until the returned function is called. */
    holdPeers: () => {
      let release = () => {};
      held = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        held = undefined;
        release();
      };
    },
  };
}

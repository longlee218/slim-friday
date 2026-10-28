import type { ComputerHold, Store } from "../../src/ports/store";

/** In-memory `Store["computerHolds"]` with the same rules as the sqlite repo. */
export function fakeComputerHolds(): Store["computerHolds"] {
  const rows = new Map<string, ComputerHold>();
  return {
    acquire: async (a) => {
      const key = a.kind === "input" ? `input:${a.computer}` : `slot:${a.botId}`;
      const old = rows.get(key);
      const live = old !== undefined && old.expiresAt > a.now;
      if (live && old.holder !== a.holder) return undefined;
      if (a.kind === "slot" && a.slotLimit !== undefined) {
        const others = [...rows.values()].filter(
          (r) => r.kind === "slot" && r.key !== key && r.expiresAt > a.now,
        ).length;
        if (others >= a.slotLimit) return undefined;
      }
      const row: ComputerHold = {
        key,
        kind: a.kind,
        computer: a.computer,
        botId: a.botId,
        holder: a.holder,
        fence: live ? old.fence : (old?.fence ?? 0) + 1,
        expiresAt: a.now + a.ttlMs,
      };
      rows.set(key, row);
      return { ...row };
    },
    renew: async (a) => {
      const r = rows.get(a.key);
      if (!r || r.holder !== a.holder || r.fence !== a.fence) return false;
      r.expiresAt = a.now + a.ttlMs;
      return true;
    },
    release: async (a) => {
      const r = rows.get(a.key);
      if (r && r.holder === a.holder && r.fence === a.fence) r.expiresAt = 0;
    },
    live: async (now) => [...rows.values()].filter((r) => r.expiresAt > now).map((r) => ({ ...r })),
  };
}

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveToTrash } from "../src/effects/trash-store";
import { sweepTrash } from "../src/lifecycle/trash-sweeper";
import { TRASH_TTL_MS } from "../src/policy/risk-types";

/* Expiry edge of the trash: an entry is kept up to exactly 7 days old and removed one millisecond later. Injected clock. */

test("an entry exactly 7 days old is kept; one millisecond older is removed", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "trash-edge-")));
  const src = join(home, "src");
  writeFileSync(src, "x");
  const t0 = 1_700_000_000_000;
  const atLimit = moveToTrash(home, "g-edge", [src], t0);
  const now = t0 + TRASH_TTL_MS;
  expect(sweepTrash(home, now)).toBe(0);
  expect(existsSync(atLimit.dir)).toBe(true);
  expect(sweepTrash(home, now + 1)).toBe(1);
  expect(existsSync(atLimit.dir)).toBe(false);
});

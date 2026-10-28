import type { ExecResult } from "@friday/core";

/** Small checks and parsers for what `cua` and the host return. */

/** A failed command as an error that names the command, never its env. */
export function must(argv: string[], res: ExecResult): ExecResult {
  if (res.code !== 0)
    throw new Error(
      `cua ${argv.slice(0, 2).join(" ")} failed (${res.code}): ${res.stderr.slice(0, 300)}`,
    );
  return res;
}

/** True when a `sandbox info` reply does not say stopped. UNVERIFIED: the `--json` state field is a guess. */
export function isRunning(stdout: string): boolean {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const s = String(j.state ?? j.status ?? "running");
    return !/stop|exit|suspend|pause|created/i.test(s);
  } catch {
    return true;
  }
}

/** PNG size from its IHDR chunk (bytes 16..24, big endian). */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24 || png[1] !== 0x50) throw new Error("screenshot is not a PNG");
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** A coordinate or step as an integer; a NaN or fraction must not reach argv. */
export function int(n: number, what: string): number {
  if (!Number.isFinite(n)) throw new Error(`${what} must be a finite number`);
  return Math.round(n);
}

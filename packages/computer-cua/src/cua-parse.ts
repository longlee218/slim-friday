import type { ComputerView, ExecResult } from "@friday/core";

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

/** Flags after the name of `cua sandbox view`: viewer opened by the caller, ticket valid 10 minutes. */
export function viewFlags(viewOnly: boolean): string[] {
  return [...(viewOnly ? ["--view-only"] : []), "--no-open", "--ttl", "10m"];
}

/** Parse `cua sandbox view --json` stdout; only a loopback http viewer URL is accepted. */
export function parseView(stdout: string): ComputerView {
  let j: { url?: unknown; expires_at_unix?: unknown };
  try {
    j = JSON.parse(stdout);
  } catch {
    throw new Error("cua sandbox view gave no JSON");
  }
  let u: URL;
  try {
    u = new URL(String(j.url));
  } catch {
    throw new Error("cua sandbox view gave no viewer url");
  }
  if (u.protocol !== "http:" || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost"))
    throw new Error("viewer url is not a loopback http url; refusing it");
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1) throw new Error("viewer url has no port");
  const secs = Number(j.expires_at_unix);
  if (!Number.isFinite(secs) || secs <= 0) throw new Error("viewer reply has no expiry");
  return { url: u.href, port, expiresAt: secs * 1000 };
}

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ComputerProviderPlugin } from "@friday/core";
import { makePortForwards } from "./cua-port-forward";
import { createCuaProvider } from "./cua-provider";
import { makeRunner, type RunEnv } from "./cua-run";

/** Options of a `computer.provider` entry with `id: cua`. */
export interface CuaOptions {
  /** Absolute path of the `cua` binary. */
  binary: string;
  /** Sandbox image (default `ghcr.io/trycua/linux:24.04-slim`); the CLI picks it with `--tier slim`. */
  image: string;
  /** The `cua` version this adapter was checked against. */
  version: string;
  /**
   * PATH and HOME handed to every child. The app resolves them from its own env (only `apps/friday/src/config`
   * reads it) and passes them here; the defaults only keep the adapter usable without them.
   */
  env: RunEnv;
  /** Docker CLI used for capacity (default `docker`, found through PATH). */
  dockerBinary: string;
}

const DEFAULTS = {
  image: "ghcr.io/trycua/linux:24.04-slim",
  version: "0.9.0",
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" },
  dockerBinary: "docker",
};
const KEYS = new Set(["binary", "image", "version", "env", "dockerBinary"]);

/** Probes of the host (fakes in tests). */
export interface CuaProbes {
  exists(path: string): boolean;
  /** Output of `cua --version`. */
  version(options: CuaOptions): string;
}

const realProbes: CuaProbes = {
  exists: existsSync,
  version(o) {
    const r = Bun.spawnSync([o.binary, "--version"], {
      env: { ...o.env, DO_NOT_TRACK: "1" },
      timeout: 10_000,
    });
    return r.exitCode === 0 ? r.stdout.toString() : "";
  },
};

const str = (v: unknown, what: string, dflt: string): string => {
  const x = v ?? dflt;
  if (typeof x !== "string" || !x) throw new Error(`cua: ${what} must be a non-empty string`);
  return x;
};

/** Build the plugin; `probes` default to the real host. */
export function makeCuaPlugin(probes: CuaProbes = realProbes): ComputerProviderPlugin<CuaOptions> {
  return {
    id: "cua",
    parseOptions(raw) {
      const extra = Object.keys(raw).filter((k) => !KEYS.has(k));
      if (extra.length) throw new Error(`cua: unknown option ${extra.join(", ")}`);
      if (typeof raw.binary !== "string" || !raw.binary) throw new Error("cua: binary is required");
      if (!isAbsolute(raw.binary)) throw new Error("cua: binary must be an absolute path");
      const e = (raw.env ?? DEFAULTS.env) as Record<string, unknown>;
      if (typeof e !== "object" || typeof e.PATH !== "string" || typeof e.HOME !== "string")
        throw new Error("cua: env needs PATH and HOME strings");
      return {
        binary: raw.binary,
        image: str(raw.image, "image", DEFAULTS.image),
        version: str(raw.version, "version", DEFAULTS.version),
        env: { PATH: e.PATH, HOME: e.HOME },
        dockerBinary: str(raw.dockerBinary, "dockerBinary", DEFAULTS.dockerBinary),
      };
    },
    check(o) {
      if (!probes.exists(o.binary)) return [`cua: binary not found at ${o.binary}`];
      const seen = probes.version(o).match(/\d+\.\d+\.\d+/)?.[0];
      if (seen !== o.version)
        return [`cua: version ${seen ?? "unknown"} found, ${o.version} expected`];
      return [];
    },
    create(o) {
      return createCuaProvider({
        run: makeRunner(o.binary, ["--json"], o.env),
        docker: makeRunner(o.dockerBinary, [], o.env),
        forwards: makePortForwards(o.binary, o.env),
      });
    },
  };
}

/** The Cua computer provider plugin. */
export const cuaPlugin = makeCuaPlugin();

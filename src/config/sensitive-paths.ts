import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shape of `data/sensitive-paths.yaml`. */
interface SensitivePaths {
  /** Basename globs of sensitive files. */
  files: string[];
  /** Dir names whose whole content is sensitive. */
  dirs: string[];
  /** Dir names the search never enters. */
  skip: string[];
}

/** The sensitive-path list of the worker sandbox: data, so adding a pattern is a data change. */
export const SENSITIVE_PATHS: SensitivePaths = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "data", "sensitive-paths.yaml"), "utf8"),
) as SensitivePaths;

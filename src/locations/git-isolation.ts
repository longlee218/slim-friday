/* The app's own git calls (push, merge, location refresh) run OUTSIDE the worker's sandbox, so the owner's global and system git
   config must not steer them: a worker that planted a `core.sshCommand`, `credential.helper` or `url.*.insteadOf` in `~/.gitconfig`
   would run code with the bot's rights. The config files are switched off; what the calls still need is passed explicitly. */
import { readProcessEnv } from "../config/process-env";

/** Env that switches off the owner's global and system git config for one git subprocess. */
export const GIT_ISOLATED_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** Cached `-c user.*` args (read once from the owner's global config; a name and an email are harmless data). */
let identityArgs: string[] | undefined;

/** The owner's commit identity as `-c user.name=.. -c user.email=..` (merge commits need one); empty when env or repo config supplies it. */
function ownerIdentityArgs(env: Record<string, string | undefined>): string[] {
  if (env.GIT_AUTHOR_NAME && env.GIT_AUTHOR_EMAIL) return [];
  if (identityArgs) return identityArgs;
  const read = (key: string): string | undefined => {
    const r = Bun.spawnSync(["git", "config", "--global", "--get", key], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const v = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    return v === "" || v.includes("\n") ? undefined : v;
  };
  const name = read("user.name");
  const email = read("user.email");
  identityArgs = [
    ...(name ? ["-c", `user.name=${name}`] : []),
    ...(email ? ["-c", `user.email=${email}`] : []),
  ];
  return identityArgs;
}

/**
 * `-c` options that replace what the global config used to provide: the credential helpers (reset first, then the keychain on
 * macOS and the `gh` helper for github.com: the same auth `gh` itself uses) and the owner's commit identity. Nothing else of the
 * global config applies. Hosts that relied on another helper need that helper added here.
 */
export function gitIsolationArgs(
  env: Record<string, string | undefined> = readProcessEnv(),
): string[] {
  return [
    ...["-c", "credential.helper="],
    ...(process.platform === "darwin" ? ["-c", "credential.helper=osxkeychain"] : []),
    ...["-c", "credential.https://github.com.helper=!gh auth git-credential"],
    ...ownerIdentityArgs(env),
  ];
}

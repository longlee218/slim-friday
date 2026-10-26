// Test preload (bunfig.toml): drop every GIT_* variable a calling git hook exported (GIT_DIR,
// GIT_INDEX_FILE, ...). Tests spawn git in temp repos and inherit process.env; with GIT_DIR set,
// `git init --bare` and `git config user.*` would change the real repository instead.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

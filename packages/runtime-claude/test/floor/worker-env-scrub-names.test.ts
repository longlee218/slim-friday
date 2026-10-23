import { expect, test } from "bun:test";
import { isWorkerEnvDenied } from "../../src/floor/child-env-deny";

/* The worker env scrub: secret-looking names never reach a worker's process. */

test("worker env scrub catches PGPASSWORD-style names", () => {
  for (const n of [
    "PGPASSWORD",
    "MYSQL_PWD",
    "NPM_CONFIG__AUTHTOKEN",
    "GITLAB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
  ])
    expect(isWorkerEnvDenied(n)).toBe(true);
  expect(isWorkerEnvDenied("PATH")).toBe(false);
});

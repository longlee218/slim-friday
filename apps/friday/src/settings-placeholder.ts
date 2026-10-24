import type { EngineDeps } from "@friday/api";

/** Throws for any call: the real admins are wired in the settings wiring task, until then a call is a 500. */
const unwired = new Proxy(
  {},
  {
    get: (_t, name) => () => {
      throw new Error(`settings admin not wired yet: ${String(name)}`);
    },
  },
);

/** Placeholder `settings` deps for the API; replaced by the real admins in the settings wiring task. */
export const unwiredSettings = {
  config: unwired,
  skills: unwired,
  memory: unwired,
  probe: () => Promise.reject(new Error("settings admin not wired yet: probe")),
} as unknown as EngineDeps["settings"];

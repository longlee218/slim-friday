/**
 * The ONE place outside `loadConfig` that touches `process.env` (scan test: no-process-env-outside-config).
 * Returns the live object (not a copy), so a test that sets a variable is seen at once. Callers that need
 * only a typed app setting use `AgentConfig`; this reader is for the owner's pass-through env (child env,
 * git scrub, HOME, SHELL, drain switch, logger bootstrap).
 */
export const readProcessEnv = (): NodeJS.ProcessEnv => process.env;

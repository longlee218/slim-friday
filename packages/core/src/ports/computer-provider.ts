import type { Log } from "./log";

/** What one bot computer is made of. `name` is `[a-z0-9-]`, unique per machine. */
export interface ComputerSpec {
  name: string;
  cpus: number;
  memoryMb: number;
}

/** What the machine can give to computers in total (the container runtime's limits). */
export interface ComputerCapacity {
  cpus: number;
  memoryMb: number;
}

/** Outcome of a command run inside a computer. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One input on the desktop of a computer. */
export type DesktopAction =
  | { kind: "click"; x: number; y: number; button?: "left" | "right"; double?: boolean }
  | { kind: "type"; text: string }
  | { kind: "key"; keys: string }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: "wait"; ms: number };

/** A picture of the desktop. */
export interface Screenshot {
  png: Uint8Array;
  width: number;
  height: number;
}

/** A computer the bot drives (a Linux desktop in a container or VM). One instance serves every computer by name. */
export interface ComputerProvider {
  /** The machine's total room for computers. */
  capacity(): Promise<ComputerCapacity>;
  /** Create the computer if missing and start it; no-op when it already runs. */
  ensure(spec: ComputerSpec): Promise<void>;
  /** Run a command (argv, no shell) inside the computer; rejects after `timeoutMs`. */
  exec(name: string, argv: string[], timeoutMs: number): Promise<ExecResult>;
  /** Start a long-lived process inside the computer and return without waiting for it. */
  launch(name: string, argv: string[], env: Record<string, string>): Promise<void>;
  /** Picture of the desktop now. */
  screenshot(name: string): Promise<Screenshot>;
  /** Send one input to the desktop. */
  act(name: string, action: DesktopAction): Promise<void>;
  /** Accessibility tree of the desktop as text. */
  accessibilityTree(name: string): Promise<string>;
  /** Reach a guest port from the host: returns `http://127.0.0.1:<port>`; idempotent per name and port. */
  forwardPort(name: string, guestPort: number): Promise<string>;
  /** Stop the computer; its disk stays. */
  stop(name: string): Promise<void>;
}

/**
 * A computer provider plugin (Cua, later others): turns the `computer.provider` entry of `settings.yaml` into a
 * `ComputerProvider`. Each plugin lives in its own package and imports only core.
 */
export interface ComputerProviderPlugin<O = unknown> {
  /** Matches `computer.provider.id` in settings.yaml. */
  id: string;
  /** Its own options from the settings entry (every key but `id`); throws a readable error. */
  parseOptions(raw: Record<string, unknown>): O;
  /** Problems that make the options unusable (binary missing); [] = usable. */
  check(options: O): string[];
  /** The provider; called only when `check` found no problem. */
  create(options: O, deps: { log: Pick<Log, "warn" | "info"> }): ComputerProvider;
}

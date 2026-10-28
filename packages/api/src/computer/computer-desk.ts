import type { ComputerProvider, ComputerSpec } from "@friday/core";

/** What the computer routes need from the engine's computers: the provider's probe and viewer, sizes and slots. */
export interface ComputerDesk {
  provider: Pick<ComputerProvider, "running" | "view">;
  /** The spec a computer is made from (the viewer is opened on it). */
  spec(computer: string): ComputerSpec;
  /** Slots this machine allows at once, with a readable line. */
  slots(): { limit: number; text: string };
}

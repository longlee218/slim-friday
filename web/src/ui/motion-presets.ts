import type { Transition } from "motion/react";

// Shared motion vocabulary: springs are critically damped (no bounce), exits are faster.

/** Selection, badges, small controls. */
export const SPRING_SNAPPY: Transition = { type: "spring", stiffness: 520, damping: 42, mass: 0.8 };
/** Messages, rows, cards arriving. */
export const SPRING_SOFT: Transition = { type: "spring", stiffness: 300, damping: 32 };
/** Quick exit. */
export const EXIT_FAST: Transition = { duration: 0.14, ease: [0.4, 0, 1, 1] };
/** Deceleration curve matching the CSS --ease token. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Enter/exit for the send ⇄ stop button swap. */
export const SWAP = {
  initial: { scale: 0.5, opacity: 0, rotate: -45 },
  animate: { scale: 1, opacity: 1, rotate: 0 },
  exit: { scale: 0.5, opacity: 0, rotate: 45 },
  transition: SPRING_SNAPPY,
} as const;

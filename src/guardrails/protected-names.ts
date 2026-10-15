/* Name rules used by DeletePaths and the secret-name check. macOS (APFS) and Windows are case-insensitive and
   macOS also treats canonically equal unicode as one name, so every protected name is compared folded. Pure. */

/** Zero-width and bidi format characters: invisible, never part of a real protected name. */
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;

/** A name in comparison form: unicode NFC, invisible characters dropped, lower case. */
export const foldName = (s: string): string =>
  s.normalize("NFC").replace(INVISIBLE, "").toLowerCase();

/** Folded name of a git dir. */
const GIT_DIR = String.fromCharCode(46) + "git";

/** True when any component of `p` is a git dir (`.git`, any case, any depth: nested repos and submodules included). */
export const hasGitComponent = (p: string): boolean =>
  p.split(/[\\/]+/).some((c) => foldName(c) === GIT_DIR);

/** True when `inner` equals or lies under `outer`, compared folded (a case variant of a protected root is the same dir). */
export const isInsideFolded = (outer: string, inner: string): boolean => {
  const o = foldName(outer).replace(/\/+$/, "");
  const i = foldName(inner);
  return i === o || i.startsWith(`${o}/`);
};

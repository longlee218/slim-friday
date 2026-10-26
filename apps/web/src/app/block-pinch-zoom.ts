/**
 * Stops pinch zoom so the PWA feels like a native app. Android honours `user-scalable=no` in the
 * viewport meta (index.html); iOS Safari ignores it, so its WebKit-only gesture events are cancelled.
 */
export function blockPinchZoom(): void {
  const cancel = (e: Event) => e.preventDefault();
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, cancel, { passive: false });
  }
}

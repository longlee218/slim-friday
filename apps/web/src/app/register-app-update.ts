/// <reference types="vite-plugin-pwa/client" />
import { registerSW } from "virtual:pwa-register";
import { applyWhenSafe, watchForUpdates } from "./app-update";

/**
 * Registers the service worker (`registerType: "prompt"`, see pwa-options.ts): a new version
 * waits until `applyWhenSafe` reloads into it, and `watchForUpdates` keeps asking for one.
 */
export function registerAppUpdate(): void {
  let pending = false;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // One reload per waiting version, however often the check finds it.
      if (pending) return;
      pending = true;
      applyWhenSafe(() => void updateSW(true));
    },
    onRegisteredSW(_url, registration) {
      if (registration) watchForUpdates(() => void registration.update().catch(() => {}));
    },
  });
}

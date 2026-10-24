// Service worker registration (vite-plugin-pwa, prompt mode): when a new
// version is waiting, surface it through the callback so the app can show
// an "update available" banner instead of silently swapping versions.
import { registerSW } from 'virtual:pwa-register';

export function registerPwa(onUpdateReady: (applyUpdate: () => void) => void): () => void {
  let cancelled = false;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      if (!cancelled) {
        onUpdateReady(() => {
          void updateSW(true);
        });
      }
    },
    onOfflineReady() {
      // The full app shell + data are precached at this point.
      console.info('App is ready to work offline.');
    },
    onRegisterError(err) {
      console.warn('Service worker registration failed:', err);
    },
  });
  return () => {
    cancelled = true;
  };
}

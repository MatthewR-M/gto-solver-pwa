import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves this project from /gto-solver-pwa/, so the base must
// match the repository name exactly.
export default defineConfig({
  base: '/gto-solver-pwa/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt', // we show our own "update available" banner
      injectRegister: false, // registration is done manually in src/pwa.ts
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'GTO Solver — Offline Poker Study',
        short_name: 'GTO Solver',
        description:
          'Offline-first GTO poker solver for personal study. CFR+ over an abstracted heads-up postflop game.',
        id: '/gto-solver-pwa/',
        start_url: '/gto-solver-pwa/',
        scope: '/gto-solver-pwa/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b3d2e',
        theme_color: '#0b3d2e',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,json,png,svg,woff2}'],
        navigateFallback: '/gto-solver-pwa/index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2020', sourcemap: false },
});

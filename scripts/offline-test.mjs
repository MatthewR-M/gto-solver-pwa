// Offline behavior test with Playwright: serves the production build,
// waits for the service worker to activate, then goes offline and checks
// the app still loads and works. Run AFTER `npm run build`:
//   node scripts/offline-test.mjs
// Exits non-zero on failure. If Playwright/Chromium is unavailable in your
// environment, use the manual checklist in the README instead.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4173;
const URL = `http://localhost:${PORT}/gto-solver-pwa/`;

function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve(true);
      } catch {
        /* not up yet */
      }
      if (Date.now() - start > timeoutMs) return reject(new Error('server did not start'));
      setTimeout(tryOnce, 400);
    };
    tryOnce();
  });
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
});

let failed = false;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed = true;
};

try {
  await waitForServer(URL);
  const browser = await chromium.launch(
    process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : undefined,
  );
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: 'networkidle' });
  check('app loads online', await page.locator('h1').isVisible());

  // Wait for the service worker to control the page (precache installed).
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: 'networkidle' });
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  check('service worker controls the page', controlled);

  // Go offline and reload: the app shell must come from the cache.
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('app loads offline', await page.locator('h1').isVisible());

  // Charts tab works offline (data is bundled + precached).
  await page.getByRole('button', { name: 'Preflop Charts' }).click();
  const cells = await page.locator('.grid-cell').count();
  check('preflop chart grid renders offline (169 cells)', cells === 169);

  // Advisor preflop lookup works offline.
  await page.getByRole('button', { name: 'Quick Advisor' }).click();
  await page.waitForSelector('.card-picker');
  check('advisor screen renders offline', true);

  await browser.close();
} catch (err) {
  console.error('Offline test error:', err);
  failed = true;
} finally {
  server.kill();
}

console.log(failed ? '\nOFFLINE TEST: FAILED' : '\nOFFLINE TEST: PASSED');
process.exit(failed ? 1 : 0);

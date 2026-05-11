import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const server = spawn(
  'npx',
  ['vite', '--config', 'vite.renderer.config.ts', '--host', '127.0.0.1', '--port', '5174'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

const logs = [];
server.stdout.on('data', (data) => logs.push(data.toString()));
server.stderr.on('data', (data) => logs.push(data.toString()));

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const notes = ['E2', 'A2', 'D3', 'G3'];
    window.guitarArt = {
      audio: {
        listDevices: async () => [],
        start: async () => undefined,
        stop: async () => undefined,
        setMode: async () => undefined,
        getLatestFeatures: async () => {
          const t = performance.now() / 1000;
          const rms = 0.2 + Math.sin(t * 2.1) * 0.12;
          return {
            t,
            rms,
            peak: Math.min(1, rms * 1.8),
            low: 0.2 + Math.sin(t * 1.7) * 0.2,
            mid: 0.35 + Math.sin(t * 2.5) * 0.22,
            high: 0.2 + Math.sin(t * 4.1) * 0.18,
            spectralCentroid: 0.45 + Math.sin(t * 1.2) * 0.3,
            pitchHz: 82.41 * Math.pow(2, (Math.floor(t) % 12) / 12),
            pitchConfidence: 0.75,
            noteName: notes[Math.floor(t) % notes.length],
            noteStability: 0.7,
            onset: Math.sin(t * 6) > 0.92 ? 0.9 : 0.05,
            gate: true,
            clipping: false
          };
        },
        onStatus: () => () => undefined
      }
    };
  });
  await page.goto('http://127.0.0.1:5174', { waitUntil: 'networkidle' });
  try {
    await page.waitForSelector('.visual-host canvas', { timeout: 10_000 });
    await page.waitForSelector('.meter-strip', { timeout: 10_000 });
  } catch (error) {
    const body = await page.locator('body').innerText().catch(() => '');
    throw new Error(`Renderer did not mount canvas.\nErrors:\n${errors.join('\n')}\nBody:\n${body}\n${error}`);
  }
  const canvasCount = await page.locator('.visual-host canvas').count();
  const meterCount = await page.locator('.meter').count();
  await browser.close();

  if (errors.length > 0) {
    throw new Error(`Renderer console errors:\n${errors.join('\n')}`);
  }
  if (canvasCount < 1 || meterCount < 9) {
    throw new Error(`Unexpected renderer shape: canvas=${canvasCount} meters=${meterCount}`);
  }

  console.log(JSON.stringify({ canvasCount, meterCount }, null, 2));
} finally {
  server.kill('SIGTERM');
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (logs.join('\n').includes('Local:')) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Vite renderer server did not start.\n${logs.join('\n')}`);
}

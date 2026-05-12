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
          const pitchClass = Math.floor(t) % 12;
          const chroma = Array.from({ length: 12 }, (_, index) => (index === pitchClass ? 1 : index === (pitchClass + 7) % 12 ? 0.72 : 0.04));
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
            clipping: false,
            chroma,
            spectralFlux: Math.sin(t * 6) > 0.92 ? 0.8 : 0.08,
            spectralRolloff: 0.54,
            spectralFlatness: 0.18,
            zeroCrossingRate: 0.22,
            brightness: 0.48,
            noisiness: 0.2,
            attack: Math.sin(t * 6) > 0.92 ? 0.85 : 0.04,
            decay: 0.08,
            bendCents: Math.sin(t * 2) * 22,
            vibratoDepth: 0.28,
            vibratoRate: 0.52,
            harmonicDensity: 0.44,
            chordRoot: 'E',
            chordQuality: 'power',
            chordName: 'E5',
            chordConfidence: 0.74
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
    await page.waitForSelector('.tuner-panel .tuner-needle', { timeout: 10_000 });
    await page.waitForSelector('.record-panel', { timeout: 10_000 });
    await page.waitForSelector('.spectrum-bars', { timeout: 10_000 });
    await page.getByRole('button', { name: '+ 3D' }).click();
    await page.locator('.layer-card').last().locator('select').selectOption('guitarGlyph3d');
    await page.waitForTimeout(250);
  } catch (error) {
    const body = await page.locator('body').innerText().catch(() => '');
    throw new Error(`Renderer did not mount canvas.\nErrors:\n${errors.join('\n')}\nBody:\n${body}\n${error}`);
  }
  const canvasCount = await page.locator('.visual-host canvas').count();
  const meterCount = await page.locator('.meter').count();
  const tunerCount = await page.locator('.tuner-panel').count();
  const tunerNeedleCount = await page.locator('.tuner-needle').count();
  const recordButtonCount = await page.getByRole('button', { name: 'Record' }).count();
  const stopButtonCount = await page.getByRole('button', { name: 'Stop' }).count();
  const spectrumPanelCount = await page.locator('.spectrum-bars').count();
  const guitarGlyphOptionCount = await page.locator('select option[value="guitarGlyph3d"]').count();
  await browser.close();

  if (errors.length > 0) {
    throw new Error(`Renderer console errors:\n${errors.join('\n')}`);
  }
  if (canvasCount < 1 || meterCount < 9) {
    throw new Error(`Unexpected renderer shape: canvas=${canvasCount} meters=${meterCount}`);
  }
  if (tunerCount !== 1 || tunerNeedleCount !== 1) {
    throw new Error(`Unexpected tuner shape: panels=${tunerCount} needles=${tunerNeedleCount}`);
  }
  if (recordButtonCount !== 1 || stopButtonCount < 2) {
    throw new Error(`Unexpected recording controls: record=${recordButtonCount} stop=${stopButtonCount}`);
  }
  if (spectrumPanelCount !== 1 || guitarGlyphOptionCount < 1) {
    throw new Error(`Unexpected guitar diagnostics/glyph controls: spectrum=${spectrumPanelCount} glyphOptions=${guitarGlyphOptionCount}`);
  }

  console.log(JSON.stringify({ canvasCount, meterCount, tunerCount, tunerNeedleCount, recordButtonCount, stopButtonCount, spectrumPanelCount, guitarGlyphOptionCount }, null, 2));
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

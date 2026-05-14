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
        startAnalysisRecording: async () => undefined,
        getAnalysisRecordingWaveform: async () => ({ durationMs: 0, totalSamples: 0, waveform: [] }),
        stopAnalysisRecording: async () => ({ sampleRate: 48000, samples: [] }),
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
            chordConfidence: 0.74,
            logSpectrum: Array.from({ length: 36 }, (_, index) => (index % 6) / 5),
            spectralContrast: 0.42,
            harmonicRatio: 0.68,
            pickNoise: Math.max(0.08, Math.sin(t * 3.2) * 0.5 + 0.35),
            muteAmount: Math.max(0.04, Math.cos(t * 2.4) * 0.38 + 0.28),
            guitarTechnique: Math.sin(t * 1.3) > 0 ? 'strum' : 'vibrato',
            guitarTechniqueConfidence: 0.78,
            stringNumber: (Math.floor(t * 2) % 6) + 1,
            fretNumber: Math.floor(t * 3) % 12,
            voicing: [
              { stringNumber: 6, fretNumber: 0, pitchClass: 4, confidence: 0.82 },
              { stringNumber: 5, fretNumber: 2, pitchClass: 11, confidence: 0.7 },
              { stringNumber: 4, fretNumber: 2, pitchClass: 4, confidence: 0.64 }
            ],
            guitarEvents: [
              {
                id: Math.floor(t * 3),
                t: t - 0.08,
                type: Math.sin(t * 2) > 0 ? 'strum' : 'pluck',
                strength: 0.72,
                noteName: 'E2',
                pitchHz: 82.41,
                stringNumber: 6,
                fretNumber: 0,
                chordName: 'E5'
              }
            ]
          };
        },
        onStatus: () => () => undefined
      }
    };
  });
  await page.goto('http://127.0.0.1:5174', { waitUntil: 'networkidle' });
  try {
    await page.waitForSelector('.visual-host canvas', { timeout: 10_000 });
    await page.waitForSelector('.dsp-meter-column', { timeout: 10_000 });
    await page.waitForSelector('.tuner-panel .tuner-needle', { timeout: 10_000 });
    await page.waitForSelector('.record-panel', { timeout: 10_000 });
    await page.waitForSelector('.spectrum-bars', { timeout: 10_000 });
    await page.locator('.layer-card').first().locator('select').selectOption('fretPulse2d');
    await page.getByRole('button', { name: '+ 2D' }).click();
    await page.locator('.layer-card').last().locator('select').selectOption('techniqueMap2d');
    await page.getByRole('button', { name: '+ 3D' }).click();
    await page.locator('.layer-card').last().locator('select').selectOption('guitarGlyph3d');
    await page.getByRole('button', { name: '+ 3D' }).click();
    await page.locator('.layer-card').last().locator('select').selectOption('stringResonator3d');
    await page.getByRole('button', { name: '+ 3D' }).click();
    await page.locator('.layer-card').last().locator('select').selectOption('techniqueShard3d');
    await page.waitForTimeout(250);
  } catch (error) {
    const body = await page.locator('body').innerText().catch(() => '');
    throw new Error(`Renderer did not mount canvas.\nErrors:\n${errors.join('\n')}\nBody:\n${body}\n${error}`);
  }
  const canvasCount = await page.locator('.visual-3d-canvas').count();
  const twoDCanvasCount = await page.locator('.visual-2d-layer').count();
  const meterCount = await page.locator('.meter').count();
  const tunerCount = await page.locator('.tuner-panel').count();
  const tunerNeedleCount = await page.locator('.tuner-needle').count();
  const snapshotButtonCount = await page.getByRole('button', { name: 'Snapshot' }).count();
  const cumulativeButtonCount = await page.getByRole('button', { name: 'Cumulative' }).count();
  const webmButtonCount = await page.getByRole('button', { name: 'WebM' }).count();
  const stopButtonCount = await page.getByRole('button', { name: 'Stop' }).count();
  const startAnalysisButtonCount = await page.getByRole('button', { name: 'Start Analysis' }).count();
  const spectrumPanelCount = await page.locator('.spectrum-bars').count();
  const guitarGlyphOptionCount = await page.locator('select option[value="guitarGlyph3d"]').count();
  const fretPulseOptionCount = await page.locator('select option[value="fretPulse2d"]').count();
  const techniqueMapOptionCount = await page.locator('select option[value="techniqueMap2d"]').count();
  const stringResonatorOptionCount = await page.locator('select option[value="stringResonator3d"]').count();
  const techniqueShardOptionCount = await page.locator('select option[value="techniqueShard3d"]').count();
  const desktopPixelStats = await getCanvasPixelStats(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  const mobilePixelStats = await getCanvasPixelStats(page);
  await browser.close();

  if (errors.length > 0) {
    throw new Error(`Renderer console errors:\n${errors.join('\n')}`);
  }
  if (canvasCount !== 1 || twoDCanvasCount < 1 || meterCount < 17) {
    throw new Error(`Unexpected renderer shape: canvas=${canvasCount} twoD=${twoDCanvasCount} meters=${meterCount}`);
  }
  if (tunerCount !== 1 || tunerNeedleCount !== 1) {
    throw new Error(`Unexpected tuner shape: panels=${tunerCount} needles=${tunerNeedleCount}`);
  }
  if (snapshotButtonCount !== 1 || cumulativeButtonCount !== 1 || webmButtonCount !== 1 || stopButtonCount < 2 || startAnalysisButtonCount !== 1) {
    throw new Error(
      `Unexpected recording controls: snapshot=${snapshotButtonCount} cumulative=${cumulativeButtonCount} webm=${webmButtonCount} stop=${stopButtonCount} startAnalysis=${startAnalysisButtonCount}`
    );
  }
  if (spectrumPanelCount !== 1 || guitarGlyphOptionCount < 1) {
    throw new Error(`Unexpected guitar diagnostics/glyph controls: spectrum=${spectrumPanelCount} glyphOptions=${guitarGlyphOptionCount}`);
  }
  if (fretPulseOptionCount < 1 || techniqueMapOptionCount < 1 || stringResonatorOptionCount < 1 || techniqueShardOptionCount < 1) {
    throw new Error(
      `Unexpected new mode controls: fretPulse=${fretPulseOptionCount} techniqueMap=${techniqueMapOptionCount} stringResonator=${stringResonatorOptionCount} techniqueShard=${techniqueShardOptionCount}`
    );
  }
  if (desktopPixelStats.lit < 12 || desktopPixelStats.avgLuma < 4 || mobilePixelStats.lit < 12 || mobilePixelStats.avgLuma < 4) {
    throw new Error(`Canvas appears blank: desktop=${JSON.stringify(desktopPixelStats)} mobile=${JSON.stringify(mobilePixelStats)}`);
  }

  console.log(JSON.stringify({ canvasCount, twoDCanvasCount, meterCount, tunerCount, tunerNeedleCount, snapshotButtonCount, cumulativeButtonCount, webmButtonCount, stopButtonCount, startAnalysisButtonCount, spectrumPanelCount, guitarGlyphOptionCount, fretPulseOptionCount, techniqueMapOptionCount, stringResonatorOptionCount, techniqueShardOptionCount, desktopPixelStats, mobilePixelStats }, null, 2));
} finally {
  server.kill('SIGTERM');
}

async function getCanvasPixelStats(page) {
  const host = await page.locator('.visual-host').elementHandle();
  return host.evaluate((node) => {
    const sample = document.createElement('canvas');
    sample.width = 64;
    sample.height = 64;
    const context = sample.getContext('2d');
    context.fillStyle = '#07090a';
    context.fillRect(0, 0, sample.width, sample.height);
    const canvases = Array.from(node.querySelectorAll('canvas')).sort((a, b) => {
      const az = Number(getComputedStyle(a).zIndex || 0);
      const bz = Number(getComputedStyle(b).zIndex || 0);
      return az - bz;
    });
    canvases.forEach((canvas) => {
      if (getComputedStyle(canvas).display === 'none') {
        return;
      }
      context.globalAlpha = Number(getComputedStyle(canvas).opacity || 1);
      context.drawImage(canvas, 0, 0, sample.width, sample.height);
    });
    context.globalAlpha = 1;
    const data = context.getImageData(0, 0, sample.width, sample.height).data;
    let lit = 0;
    let sum = 0;
    for (let index = 0; index < data.length; index += 4) {
      const luma = data[index] + data[index + 1] + data[index + 2];
      sum += luma;
      if (luma > 48) {
        lit += 1;
      }
    }
    return { lit, avgLuma: sum / (data.length / 4) };
  });
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

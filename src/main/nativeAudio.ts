import path from 'node:path';
import fs from 'node:fs';
import type { AudioDevice, AudioFeatures, AudioMode, AudioParamsUpdate, AudioStartConfig, AudioStatus } from '../shared/audio';
import { DEFAULT_FEATURES } from '../shared/audio';

type NativeAudioEngine = {
  listDevices: () => AudioDevice[];
  start: (config: AudioStartConfig) => void;
  stop: () => void;
  setMode: (mode: AudioMode) => void;
  setParams?: (params: AudioParamsUpdate) => void;
  getLatestFeatures: () => AudioFeatures;
};

const NOTE_SEQUENCE = [
  { noteName: 'E2', pitchHz: 82.41 },
  { noteName: 'A2', pitchHz: 110.0 },
  { noteName: 'D3', pitchHz: 146.83 },
  { noteName: 'G3', pitchHz: 196.0 },
  { noteName: 'B3', pitchHz: 246.94 },
  { noteName: 'E4', pitchHz: 329.63 }
];

export class AudioEngineHost {
  private native: NativeAudioEngine | null;
  private mode: AudioMode = 'simulator';
  private running = false;
  private startedAt = performance.now();
  private latestStatus: AudioStatus;

  constructor() {
    this.native = loadNativeAudioEngine();
    this.latestStatus = {
      running: false,
      mode: 'simulator',
      nativeAvailable: Boolean(this.native),
      message: this.native ? 'Native audio engine loaded.' : 'Native engine unavailable; simulator is active.'
    };
  }

  getStatus(): AudioStatus {
    return this.latestStatus;
  }

  listDevices(): AudioDevice[] {
    if (!this.native) {
      return [];
    }

    try {
      return this.native.listDevices();
    } catch {
      return [];
    }
  }

  start(config: AudioStartConfig): void {
    this.mode = config.mode;
    this.running = true;
    this.startedAt = performance.now();

    if (config.mode === 'live' && this.native) {
      this.native.start(config);
      this.latestStatus = {
        running: true,
        mode: config.mode,
        nativeAvailable: true,
        message: 'Native live input running.'
      };
      return;
    }

    if (config.mode === 'live' && !this.native) {
      this.mode = 'simulator';
      this.latestStatus = {
        running: true,
        mode: 'simulator',
        nativeAvailable: false,
        message: 'Native engine is not built yet; simulator is running instead.'
      };
      return;
    }

    this.native?.setMode('simulator');
    this.latestStatus = {
      running: true,
      mode: 'simulator',
      nativeAvailable: Boolean(this.native),
      message: 'Simulator running.'
    };
  }

  stop(): void {
    this.running = false;
    this.native?.stop();
    this.latestStatus = {
      running: false,
      mode: this.mode,
      nativeAvailable: Boolean(this.native),
      message: 'Audio stopped.'
    };
  }

  setMode(mode: AudioMode): void {
    this.mode = mode;
    this.native?.setMode(mode);
    this.latestStatus = {
      ...this.latestStatus,
      mode,
      message: mode === 'live' ? 'Live mode selected.' : 'Simulator mode selected.'
    };
  }

  setParams(params: AudioParamsUpdate): void {
    this.native?.setParams?.(params);
  }

  getLatestFeatures(): AudioFeatures {
    if (this.running && this.mode === 'live' && this.native) {
      return normalizeFeatures(this.native.getLatestFeatures());
    }

    if (!this.running) {
      return DEFAULT_FEATURES;
    }

    return makeSimulatorFeatures((performance.now() - this.startedAt) / 1000);
  }
}

function normalizeFeatures(features: Partial<AudioFeatures>): AudioFeatures {
  return {
    ...DEFAULT_FEATURES,
    ...features,
    pitchHz: features.pitchHz ?? null,
    noteName: features.noteName ?? null
  };
}

function loadNativeAudioEngine(): NativeAudioEngine | null {
  const candidates = [
    path.join(process.cwd(), 'native/audio-engine/index.js'),
    path.join(process.cwd(), 'native/audio-engine/audio_engine.node'),
    path.join(process.resourcesPath ?? '', 'audio-engine/index.js'),
    path.join(process.resourcesPath ?? '', 'audio-engine/audio_engine.darwin-arm64.node')
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    try {
      const mod = require(candidate) as { AudioEngine?: new () => NativeAudioEngine; default?: unknown };
      if (mod.AudioEngine) {
        return new mod.AudioEngine();
      }
    } catch {
      // Keep trying other paths; the renderer can still use the simulator.
    }
  }

  return null;
}

function makeSimulatorFeatures(t: number): AudioFeatures {
  const phrase = t % 18;
  const note = NOTE_SEQUENCE[Math.floor(t * 0.72) % NOTE_SEQUENCE.length];
  const attackPulse = pulse(phrase, 1.0, 0.06) + pulse(phrase, 4.2, 0.05) + pulse(phrase, 9.5, 0.04);
  const mutedRun = phrase > 6 && phrase < 8.4 ? 0.45 + 0.35 * Math.sin(t * 38) ** 2 : 0;
  const noisyStrum = phrase > 12.5 && phrase < 15.2 ? 0.42 + 0.28 * noise(t * 6.1) : 0;
  const sustained = phrase > 1.0 && phrase < 5.2 ? 0.5 + 0.2 * Math.sin(t * 2.3) : 0;
  const bend = phrase > 9.2 && phrase < 12.2 ? (phrase - 9.2) / 3 : 0;
  const silence = phrase > 15.2;
  const rms = silence ? 0.004 : clamp01(0.08 + sustained + mutedRun * 0.5 + noisyStrum + attackPulse * 0.8);
  const high = clamp01(noisyStrum * 0.95 + attackPulse * 0.55 + 0.08 * Math.sin(t * 17) ** 2);
  const mid = clamp01(sustained * 0.8 + mutedRun * 0.35 + attackPulse * 0.35);
  const low = clamp01(rms * 0.5 + Math.max(0, Math.sin(t * 1.7)) * 0.18);
  const pitchHz = note.pitchHz * (1 + bend * 0.18 + Math.sin(t * 5.8) * 0.004);
  const confidence = silence || noisyStrum > 0.5 ? 0.18 : clamp01(0.62 + sustained * 0.36 - mutedRun * 0.25);
  const gate = rms > 0.025;

  return {
    t,
    rms: clamp01(rms),
    peak: clamp01(rms * 1.7 + attackPulse * 0.4),
    low,
    mid,
    high,
    spectralCentroid: clamp01(0.16 + high * 0.72 + mid * 0.16),
    pitchHz: gate ? pitchHz : null,
    pitchConfidence: confidence,
    noteName: gate ? note.noteName : null,
    noteStability: clamp01(confidence * (1 - noisyStrum) * (sustained > 0 ? 1 : 0.55)),
    onset: clamp01(attackPulse + Math.max(0, Math.sin(t * 22)) * mutedRun * 0.18),
    gate,
    clipping: rms > 0.92
  };
}

function pulse(x: number, center: number, width: number): number {
  return Math.exp(-((x - center) * (x - center)) / (2 * width * width));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function noise(x: number): number {
  return Math.sin(x * 12.9898) * 43758.5453 % 1;
}

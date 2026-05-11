import type { AudioDevice, AudioFeatures, AudioMode, AudioStartConfig, AudioStatus } from '../shared/audio';
import { DEFAULT_FEATURES } from '../shared/audio';

type AudioClient = Window['guitarArt']['audio'];

const NOTES = [
  { noteName: 'E2', pitchHz: 82.41 },
  { noteName: 'A2', pitchHz: 110.0 },
  { noteName: 'D3', pitchHz: 146.83 },
  { noteName: 'G3', pitchHz: 196.0 },
  { noteName: 'B3', pitchHz: 246.94 },
  { noteName: 'E4', pitchHz: 329.63 }
];

let fallbackStartedAt = performance.now();
let fallbackRunning = false;
let fallbackMode: AudioMode = 'simulator';
const fallbackStatusListeners = new Set<(status: AudioStatus) => void>();

export function getAudioClient(): AudioClient {
  return window.guitarArt?.audio ?? fallbackAudioClient;
}

const fallbackAudioClient: AudioClient = {
  listDevices: async (): Promise<AudioDevice[]> => [],
  start: async (config: AudioStartConfig): Promise<void> => {
    fallbackStartedAt = performance.now();
    fallbackRunning = true;
    fallbackMode = config.mode === 'live' ? 'simulator' : config.mode;
    emitFallbackStatus('Electron preload unavailable; browser simulator is running.');
  },
  stop: async (): Promise<void> => {
    fallbackRunning = false;
    emitFallbackStatus('Simulator stopped.');
  },
  setMode: async (mode: AudioMode): Promise<void> => {
    fallbackMode = mode === 'live' ? 'simulator' : mode;
    emitFallbackStatus('Electron preload unavailable; simulator mode selected.');
  },
  getLatestFeatures: async (): Promise<AudioFeatures> => {
    if (!fallbackRunning) {
      return DEFAULT_FEATURES;
    }

    return makeSimulatorFeatures((performance.now() - fallbackStartedAt) / 1000);
  },
  onStatus: (listener: (status: AudioStatus) => void) => {
    fallbackStatusListeners.add(listener);
    listener(makeFallbackStatus('Electron preload unavailable; browser simulator is ready.'));
    return () => {
      fallbackStatusListeners.delete(listener);
    };
  }
};

function emitFallbackStatus(message: string) {
  const status = makeFallbackStatus(message);
  fallbackStatusListeners.forEach((listener) => listener(status));
}

function makeFallbackStatus(message: string): AudioStatus {
  return {
    running: fallbackRunning,
    mode: fallbackMode,
    nativeAvailable: false,
    message
  };
}

function makeSimulatorFeatures(t: number): AudioFeatures {
  const phrase = t % 18;
  const note = NOTES[Math.floor(t * 0.72) % NOTES.length];
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
  const pitchConfidence = silence || noisyStrum > 0.5 ? 0.18 : clamp01(0.62 + sustained * 0.36 - mutedRun * 0.25);
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
    pitchConfidence,
    noteName: gate ? note.noteName : null,
    noteStability: clamp01(pitchConfidence * (1 - noisyStrum) * (sustained > 0 ? 1 : 0.55)),
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
  return (Math.sin(x * 12.9898) * 43758.5453) % 1;
}

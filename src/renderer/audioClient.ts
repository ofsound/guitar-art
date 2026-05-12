import type {
  AudioDevice,
  AudioFeatures,
  AudioMode,
  AudioParamsUpdate,
  AudioStartConfig,
  AudioStatus,
  PngExportRequest,
  PngExportResult
} from '../shared/audio';
import { DEFAULT_FEATURES, DEFAULT_START_CONFIG } from '../shared/audio';

type AudioClient = Window['guitarArt']['audio'];
type ArtClient = Window['guitarArt']['art'];

const NOTES = [
  { noteName: 'E2', pitchHz: 82.41 },
  { noteName: 'A2', pitchHz: 110.0 },
  { noteName: 'D3', pitchHz: 146.83 },
  { noteName: 'G3', pitchHz: 196.0 },
  { noteName: 'B3', pitchHz: 246.94 },
  { noteName: 'E4', pitchHz: 329.63 }
];
const SIM_CHORDS = [
  { root: 'E', quality: 'power' as const, name: 'E5', classes: [4, 11] },
  { root: 'G', quality: 'major' as const, name: 'G', classes: [7, 11, 2] },
  { root: 'A', quality: 'minor' as const, name: 'Am', classes: [9, 0, 4] },
  { root: 'D', quality: 'sus4' as const, name: 'Dsus4', classes: [2, 7, 9] }
];

let fallbackStartedAt = performance.now();
let fallbackRunning = false;
let fallbackMode: AudioMode = 'simulator';
let fallbackParams = {
  inputGain: DEFAULT_START_CONFIG.inputGain,
  gateThreshold: DEFAULT_START_CONFIG.gateThreshold
};
const fallbackStatusListeners = new Set<(status: AudioStatus) => void>();

export function getAudioClient(): AudioClient {
  return window.guitarArt?.audio ?? fallbackAudioClient;
}

export function getArtClient(): ArtClient {
  return window.guitarArt?.art ?? fallbackArtClient;
}

const fallbackAudioClient: AudioClient = {
  listDevices: async (): Promise<AudioDevice[]> => [],
  start: async (config: AudioStartConfig): Promise<void> => {
    fallbackStartedAt = performance.now();
    fallbackRunning = true;
    fallbackMode = config.mode === 'live' ? 'simulator' : config.mode;
    fallbackParams = {
      inputGain: config.inputGain,
      gateThreshold: config.gateThreshold
    };
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
  setParams: async (params: AudioParamsUpdate): Promise<void> => {
    fallbackParams = applyParams(fallbackParams, params);
  },
  getLatestFeatures: async (): Promise<AudioFeatures> => {
    if (!fallbackRunning) {
      return DEFAULT_FEATURES;
    }

    return makeSimulatorFeatures((performance.now() - fallbackStartedAt) / 1000, fallbackParams);
  },
  onStatus: (listener: (status: AudioStatus) => void) => {
    fallbackStatusListeners.add(listener);
    listener(makeFallbackStatus('Electron preload unavailable; browser simulator is ready.'));
    return () => {
      fallbackStatusListeners.delete(listener);
    };
  }
};

const fallbackArtClient: ArtClient = {
  exportPng: async (request: PngExportRequest): Promise<PngExportResult> => {
    const anchor = document.createElement('a');
    anchor.href = request.dataUrl;
    anchor.download = request.suggestedName.endsWith('.png') ? request.suggestedName : `${request.suggestedName}.png`;
    anchor.click();
    return { canceled: false };
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

function makeSimulatorFeatures(t: number, params: Pick<AudioStartConfig, 'inputGain' | 'gateThreshold'>): AudioFeatures {
  const phrase = t % 18;
  const note = NOTES[Math.floor(t * 0.72) % NOTES.length];
  const attackPulse = pulse(phrase, 1.0, 0.06) + pulse(phrase, 4.2, 0.05) + pulse(phrase, 9.5, 0.04);
  const mutedRun = phrase > 6 && phrase < 8.4 ? 0.45 + 0.35 * Math.sin(t * 38) ** 2 : 0;
  const noisyStrum = phrase > 12.5 && phrase < 15.2 ? 0.42 + 0.28 * noise(t * 6.1) : 0;
  const sustained = phrase > 1.0 && phrase < 5.2 ? 0.5 + 0.2 * Math.sin(t * 2.3) : 0;
  const bend = phrase > 9.2 && phrase < 12.2 ? (phrase - 9.2) / 3 : 0;
  const vibrato = phrase > 9.6 && phrase < 12.8 ? Math.sin(t * 32) : 0;
  const silence = phrase > 15.2;
  const rawRms = silence ? 0.004 : clamp01(0.08 + sustained + mutedRun * 0.5 + noisyStrum + attackPulse * 0.8);
  const rms = clamp01(rawRms * params.inputGain);
  const high = clamp01(noisyStrum * 0.95 + attackPulse * 0.55 + 0.08 * Math.sin(t * 17) ** 2);
  const mid = clamp01(sustained * 0.8 + mutedRun * 0.35 + attackPulse * 0.35);
  const low = clamp01(rms * 0.5 + Math.max(0, Math.sin(t * 1.7)) * 0.18);
  const pitchHz = note.pitchHz * (1 + bend * 0.18 + vibrato * 0.012 + Math.sin(t * 5.8) * 0.004);
  const pitchConfidence = silence || noisyStrum > 0.5 ? 0.18 : clamp01(0.62 + sustained * 0.36 - mutedRun * 0.25);
  const gate = rms > params.gateThreshold;
  const chord = phrase < 15.2 ? SIM_CHORDS[Math.floor(t * 0.18) % SIM_CHORDS.length] : null;
  const chroma = makeSimulatorChroma(note.pitchHz, chord, gate);
  const spectralFlux = clamp01(attackPulse * 0.9 + mutedRun * 0.24 + noisyStrum * 0.34);
  const spectralFlatness = clamp01(noisyStrum * 0.65 + mutedRun * 0.22 + high * 0.12);
  const zeroCrossingRate = clamp01(high * 0.55 + noisyStrum * 0.42);
  const brightness = clamp01(high * 0.82 + spectralFlatness * 0.24);
  const harmonicDensity = chord ? clamp01(0.35 + chord.classes.length * 0.11 + mid * 0.18) : 0;

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
    onset: clamp01(Math.max(attackPulse + Math.max(0, Math.sin(t * 22)) * mutedRun * 0.18, spectralFlux)),
    gate,
    clipping: rms > 0.92,
    chroma,
    spectralFlux,
    spectralRolloff: clamp01(0.18 + high * 0.65 + noisyStrum * 0.14),
    spectralFlatness,
    zeroCrossingRate,
    brightness,
    noisiness: clamp01(spectralFlatness * 0.72 + zeroCrossingRate * 0.28),
    attack: clamp01(attackPulse + spectralFlux * 0.5),
    decay: phrase > 5.2 && phrase < 6.2 ? clamp01((phrase - 5.2) * 0.65) : silence ? 0.35 : 0,
    bendCents: bend * 180 + vibrato * 18,
    vibratoDepth: Math.abs(vibrato) > 0.1 ? 0.36 : 0,
    vibratoRate: Math.abs(vibrato) > 0.1 ? 0.62 : 0,
    harmonicDensity,
    chordRoot: gate && chord ? chord.root : null,
    chordQuality: gate && chord ? chord.quality : null,
    chordName: gate && chord ? chord.name : null,
    chordConfidence: gate && chord ? clamp01(0.58 + mid * 0.28 - noisyStrum * 0.22) : 0
  };
}

function pulse(x: number, center: number, width: number): number {
  return Math.exp(-((x - center) * (x - center)) / (2 * width * width));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function applyParams(
  current: Pick<AudioStartConfig, 'inputGain' | 'gateThreshold'>,
  update: AudioParamsUpdate
): Pick<AudioStartConfig, 'inputGain' | 'gateThreshold'> {
  return {
    inputGain: validParam(update.inputGain) ?? current.inputGain,
    gateThreshold: validParam(update.gateThreshold) ?? current.gateThreshold
  };
}

function validParam(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function makeSimulatorChroma(
  pitchHz: number,
  chord: (typeof SIM_CHORDS)[number] | null,
  gate: boolean
): number[] {
  const chroma = Array.from({ length: 12 }, () => 0.02);
  if (!gate) {
    return chroma.map(() => 0);
  }
  if (chord) {
    chord.classes.forEach((pitchClass, index) => {
      chroma[pitchClass] = index === 0 ? 1 : 0.76;
    });
  }
  const noteClass = pitchClassFromHz(pitchHz);
  chroma[noteClass] = Math.max(chroma[noteClass], 0.88);
  return chroma;
}

function pitchClassFromHz(freq: number): number {
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  return ((midi % 12) + 12) % 12;
}

function noise(x: number): number {
  return (Math.sin(x * 12.9898) * 43758.5453) % 1;
}

import path from 'node:path';
import fs from 'node:fs';
import type { AudioDevice, AudioFeatures, AudioMode, AudioParamsUpdate, AudioStartConfig, AudioStatus, GuitarEvent, GuitarTechnique, GuitarVoicingCandidate } from '../shared/audio';
import { DEFAULT_FEATURES, DEFAULT_START_CONFIG } from '../shared/audio';

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
const SIM_CHORDS = [
  { root: 'E', quality: 'power' as const, name: 'E5', classes: [4, 11] },
  { root: 'G', quality: 'major' as const, name: 'G', classes: [7, 11, 2] },
  { root: 'A', quality: 'minor' as const, name: 'Am', classes: [9, 0, 4] },
  { root: 'D', quality: 'sus4' as const, name: 'Dsus4', classes: [2, 7, 9] }
];
const GUITAR_STRINGS = [
  { stringNumber: 6, midi: 40 },
  { stringNumber: 5, midi: 45 },
  { stringNumber: 4, midi: 50 },
  { stringNumber: 3, midi: 55 },
  { stringNumber: 2, midi: 59 },
  { stringNumber: 1, midi: 64 }
];
const VALID_TECHNIQUES = new Set<GuitarTechnique>([
  'idle',
  'single_note',
  'strum',
  'palm_mute',
  'scrape',
  'noise',
  'sustain',
  'bend',
  'vibrato'
]);

type SimulatorParams = Pick<AudioStartConfig, 'inputGain' | 'gateThreshold'>;

export class AudioEngineHost {
  private native: NativeAudioEngine | null;
  private mode: AudioMode = 'simulator';
  private running = false;
  private startedAt = performance.now();
  private simulatorParams: SimulatorParams = {
    inputGain: DEFAULT_START_CONFIG.inputGain,
    gateThreshold: DEFAULT_START_CONFIG.gateThreshold
  };
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
    this.simulatorParams = {
      inputGain: config.inputGain,
      gateThreshold: config.gateThreshold
    };

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
    this.simulatorParams = applyParams(this.simulatorParams, params);
    this.native?.setParams?.(params);
  }

  getLatestFeatures(): AudioFeatures {
    if (this.running && this.mode === 'live' && this.native) {
      return normalizeFeatures(this.native.getLatestFeatures());
    }

    if (!this.running) {
      return DEFAULT_FEATURES;
    }

    return makeSimulatorFeatures((performance.now() - this.startedAt) / 1000, this.simulatorParams);
  }
}

function normalizeFeatures(features: Partial<AudioFeatures>): AudioFeatures {
  return {
    ...DEFAULT_FEATURES,
    ...features,
    chroma: normalizeChroma(features.chroma),
    logSpectrum: normalizeVector(features.logSpectrum, 36),
    voicing: normalizeVoicing(features.voicing),
    guitarEvents: normalizeGuitarEvents(features.guitarEvents),
    pitchHz: features.pitchHz ?? null,
    noteName: features.noteName ?? null,
    chordRoot: features.chordRoot ?? null,
    chordQuality: features.chordQuality ?? null,
    chordName: features.chordName ?? null,
    guitarTechnique: normalizeTechnique(features.guitarTechnique),
    stringNumber: normalizeNullableNumber(features.stringNumber),
    fretNumber: normalizeNullableNumber(features.fretNumber)
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

function makeSimulatorFeatures(t: number, params: SimulatorParams): AudioFeatures {
  const phrase = t % 18;
  const note = NOTE_SEQUENCE[Math.floor(t * 0.72) % NOTE_SEQUENCE.length];
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
  const confidence = silence || noisyStrum > 0.5 ? 0.18 : clamp01(0.62 + sustained * 0.36 - mutedRun * 0.25);
  const gate = rms > params.gateThreshold;
  const chord = phrase < 15.2 ? SIM_CHORDS[Math.floor(t * 0.18) % SIM_CHORDS.length] : null;
  const chroma = makeSimulatorChroma(note.pitchHz, chord, gate);
  const spectralFlux = clamp01(attackPulse * 0.9 + mutedRun * 0.24 + noisyStrum * 0.34);
  const spectralFlatness = clamp01(noisyStrum * 0.65 + mutedRun * 0.22 + high * 0.12);
  const zeroCrossingRate = clamp01(high * 0.55 + noisyStrum * 0.42);
  const brightness = clamp01(high * 0.82 + spectralFlatness * 0.24);
  const harmonicDensity = chord ? clamp01(0.35 + chord.classes.length * 0.11 + mid * 0.18) : 0;
  const spectralContrast = clamp01(0.24 + high * 0.28 + spectralFlux * 0.22 + harmonicDensity * 0.18);
  const harmonicRatio = clamp01(confidence * (1 - spectralFlatness * 0.5));
  const pickNoise = clamp01(high * 0.42 + spectralFlux * 0.36 + spectralFlatness * 0.22);
  const muteAmount = clamp01(mutedRun * 0.75 + spectralFlatness * 0.18 + (phrase > 5.2 && phrase < 6.2 ? 0.22 : 0));
  const guitarTechnique = getSimulatorTechnique({
    silence,
    mutedRun,
    noisyStrum,
    sustained,
    bend,
    vibrato,
    harmonicDensity
  });
  const fretted = inferStringFret(pitchHz, confidence);
  const voicing = makeSimulatorVoicing(chroma, pitchHz, chord ? 0.7 : confidence);
  const guitarEvents = makeSimulatorEvents(t, {
    gate,
    attackPulse,
    spectralFlux,
    guitarTechnique,
    noteName: note.noteName,
    pitchHz,
    fretted,
    chordName: chord?.name ?? null
  });

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
    chordConfidence: gate && chord ? clamp01(0.58 + mid * 0.28 - noisyStrum * 0.22) : 0,
    logSpectrum: makeSimulatorLogSpectrum(low, mid, high, pitchHz, gate),
    spectralContrast,
    harmonicRatio,
    pickNoise,
    muteAmount,
    guitarTechnique,
    guitarTechniqueConfidence: gate ? clamp01(0.56 + Math.max(mutedRun, noisyStrum, sustained, Math.abs(vibrato)) * 0.34) : 1,
    stringNumber: gate ? fretted?.stringNumber ?? null : null,
    fretNumber: gate ? fretted?.fretNumber ?? null : null,
    voicing: gate ? voicing : [],
    guitarEvents
  };
}

function pulse(x: number, center: number, width: number): number {
  return Math.exp(-((x - center) * (x - center)) / (2 * width * width));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function applyParams(current: SimulatorParams, update: AudioParamsUpdate): SimulatorParams {
  return {
    inputGain: validParam(update.inputGain) ?? current.inputGain,
    gateThreshold: validParam(update.gateThreshold) ?? current.gateThreshold
  };
}

function validParam(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeChroma(chroma: number[] | undefined): number[] {
  if (!Array.isArray(chroma)) {
    return [...DEFAULT_FEATURES.chroma];
  }
  return Array.from({ length: 12 }, (_, index) => clamp01(Number(chroma[index]) || 0));
}

function normalizeVector(values: number[] | undefined, length: number): number[] {
  if (!Array.isArray(values)) {
    return Array.from({ length }, (_, index) => DEFAULT_FEATURES.logSpectrum[index] ?? 0);
  }
  return Array.from({ length }, (_, index) => clamp01(Number(values[index]) || 0));
}

function normalizeNullableNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeTechnique(value: unknown): GuitarTechnique {
  return typeof value === 'string' && VALID_TECHNIQUES.has(value as GuitarTechnique) ? (value as GuitarTechnique) : 'idle';
}

function normalizeVoicing(value: GuitarVoicingCandidate[] | undefined): GuitarVoicingCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((candidate) => ({
      stringNumber: Number(candidate.stringNumber),
      fretNumber: Number(candidate.fretNumber),
      pitchClass: Number(candidate.pitchClass),
      confidence: clamp01(Number(candidate.confidence) || 0)
    }))
    .filter((candidate) =>
      Number.isFinite(candidate.stringNumber) &&
      Number.isFinite(candidate.fretNumber) &&
      Number.isFinite(candidate.pitchClass)
    );
}

function normalizeGuitarEvents(value: GuitarEvent[] | undefined): GuitarEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((event) => ({
      id: Number(event.id) || 0,
      t: Number(event.t) || 0,
      type: event.type,
      strength: clamp01(Number(event.strength) || 0),
      noteName: event.noteName ?? null,
      pitchHz: normalizeNullableNumber(event.pitchHz),
      stringNumber: normalizeNullableNumber(event.stringNumber),
      fretNumber: normalizeNullableNumber(event.fretNumber),
      chordName: event.chordName ?? null
    }))
    .filter((event) => event.id > 0 && typeof event.type === 'string');
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

function inferStringFret(pitchHz: number, confidence: number): { stringNumber: number; fretNumber: number; confidence: number } | null {
  if (!Number.isFinite(pitchHz) || pitchHz <= 0 || confidence < 0.2) {
    return null;
  }
  const midi = Math.round(69 + 12 * Math.log2(pitchHz / 440));
  let best: { stringNumber: number; fretNumber: number; confidence: number; score: number } | null = null;
  GUITAR_STRINGS.forEach((string) => {
    const fret = midi - string.midi;
    if (fret < 0 || fret > 24) {
      return;
    }
    const score = fret <= 12 ? fret * 0.018 : 0.22 + fret * 0.022;
    const candidate = {
      stringNumber: string.stringNumber,
      fretNumber: fret,
      confidence: clamp01(confidence * (1 - score * 0.5)),
      score
    };
    if (!best || candidate.score < best.score) {
      best = candidate;
    }
  });
  return best;
}

function makeSimulatorVoicing(chroma: number[], pitchHz: number, confidence: number): GuitarVoicingCandidate[] {
  const mono = inferStringFret(pitchHz, confidence);
  const used = new Set<number>();
  const voicing: GuitarVoicingCandidate[] = [];
  if (mono) {
    used.add(mono.stringNumber);
    voicing.push({ ...mono, pitchClass: pitchClassFromHz(pitchHz) });
  }
  chroma
    .map((value, pitchClass) => ({ value, pitchClass }))
    .filter((item) => item.value > 0.3)
    .slice(0, 6)
    .forEach((item) => {
      const candidate = GUITAR_STRINGS.find((string) => !used.has(string.stringNumber) && (string.midi % 12) === item.pitchClass);
      if (!candidate) {
        return;
      }
      used.add(candidate.stringNumber);
      voicing.push({
        stringNumber: candidate.stringNumber,
        fretNumber: 0,
        pitchClass: item.pitchClass,
        confidence: clamp01(item.value * confidence)
      });
    });
  return voicing;
}

function getSimulatorTechnique(input: {
  silence: boolean;
  mutedRun: number;
  noisyStrum: number;
  sustained: number;
  bend: number;
  vibrato: number;
  harmonicDensity: number;
}): GuitarTechnique {
  if (input.silence) return 'idle';
  if (input.noisyStrum > 0.55) return 'scrape';
  if (input.mutedRun > 0.35) return 'palm_mute';
  if (Math.abs(input.vibrato) > 0.35) return 'vibrato';
  if (input.bend > 0.08) return 'bend';
  if (input.harmonicDensity > 0.52) return 'strum';
  if (input.sustained > 0.35) return 'sustain';
  return 'single_note';
}

function makeSimulatorLogSpectrum(low: number, mid: number, high: number, pitchHz: number, gate: boolean): number[] {
  if (!gate) {
    return Array.from({ length: 36 }, () => 0);
  }
  const pitchClass = pitchClassFromHz(pitchHz);
  return Array.from({ length: 36 }, (_, index) => {
    const region = index < 10 ? low : index < 24 ? mid : high;
    const harmonic = index % 12 === pitchClass ? 0.55 : index % 12 === (pitchClass + 7) % 12 ? 0.35 : 0;
    return clamp01(region * (0.35 + index / 72) + harmonic);
  });
}

function makeSimulatorEvents(
  t: number,
  input: {
    gate: boolean;
    attackPulse: number;
    spectralFlux: number;
    guitarTechnique: GuitarTechnique;
    noteName: string;
    pitchHz: number;
    fretted: { stringNumber: number; fretNumber: number } | null;
    chordName: string | null;
  }
): GuitarEvent[] {
  if (!input.gate) {
    return [];
  }
  const strength = clamp01(Math.max(input.attackPulse, input.spectralFlux));
  if (strength < 0.35 && input.guitarTechnique !== 'vibrato' && input.guitarTechnique !== 'bend') {
    return [];
  }
  const type = input.guitarTechnique === 'strum' || input.guitarTechnique === 'scrape' ? 'strum' : input.guitarTechnique === 'palm_mute' ? 'mute' : input.guitarTechnique === 'bend' ? 'bend' : input.guitarTechnique === 'vibrato' ? 'vibrato' : 'pluck';
  return [{
    id: Math.floor(t * 1000),
    t,
    type,
    strength: Math.max(strength, 0.45),
    noteName: input.noteName,
    pitchHz: input.pitchHz,
    stringNumber: input.fretted?.stringNumber ?? null,
    fretNumber: input.fretted?.fretNumber ?? null,
    chordName: input.chordName
  }];
}

function noise(x: number): number {
  return Math.sin(x * 12.9898) * 43758.5453 % 1;
}

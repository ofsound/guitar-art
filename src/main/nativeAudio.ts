import path from 'node:path';
import fs from 'node:fs';
import type { AnalysisRecordingWaveform, AudioDevice, AudioFeatures, AudioMode, AudioParamsUpdate, AudioStartConfig, AudioStatus, GuitarEvent, GuitarTechnique, GuitarVoicingCandidate, RawAudioRecording } from '../shared/audio';
import { DEFAULT_FEATURES, DEFAULT_START_CONFIG } from '../shared/audio';

type NativeAudioEngine = {
  listDevices: () => AudioDevice[];
  start: (config: AudioStartConfig) => void;
  stop: () => void;
  setMode: (mode: AudioMode) => void;
  setParams?: (params: AudioParamsUpdate) => void;
  getLatestFeatures: () => AudioFeatures;
  startAnalysisRecording?: (config: AudioStartConfig) => void;
  getAnalysisRecordingWaveform?: () => AnalysisRecordingWaveform;
  stopAnalysisRecording?: () => RawAudioRecording;
};

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

export class AudioEngineHost {
  private native: NativeAudioEngine | null;
  private mode: AudioMode = DEFAULT_START_CONFIG.mode;
  private running = false;
  private libraryRecording = false;
  private latestStatus: AudioStatus;

  constructor() {
    this.native = loadNativeAudioEngine();
    this.latestStatus = {
      running: false,
      mode: DEFAULT_START_CONFIG.mode,
      nativeAvailable: Boolean(this.native),
      message: this.native ? 'Native audio engine loaded.' : 'Native audio engine unavailable.'
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

    if (config.mode === 'live' && this.native) {
      this.running = true;
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
      this.running = false;
      this.latestStatus = {
        running: false,
        mode: 'live',
        nativeAvailable: false,
        message: 'Native audio engine is unavailable.'
      };
      throw new Error('Native audio engine is unavailable.');
    }

    if (config.mode === 'playback') {
      this.running = true;
      this.native?.stop();
      this.latestStatus = {
        running: true,
        mode: 'playback',
        nativeAvailable: Boolean(this.native),
        message: 'Playback running.'
      };
      return;
    }
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
      message: mode === 'live' ? 'Live mode selected.' : 'Playback mode selected.'
    };
  }

  setParams(params: AudioParamsUpdate): void {
    this.native?.setParams?.(params);
  }

  getLatestFeatures(): AudioFeatures {
    if (this.running && this.mode === 'live' && this.native) {
      return normalizeFeatures(this.native.getLatestFeatures());
    }

    if (this.mode === 'playback') {
      return DEFAULT_FEATURES;
    }

    if (!this.running) {
      return DEFAULT_FEATURES;
    }

    return DEFAULT_FEATURES;
  }

  startAnalysisRecording(config: AudioStartConfig): void {
    if (!this.native?.startAnalysisRecording) {
      throw new Error('Native audio analysis recording is unavailable.');
    }
    this.native.startAnalysisRecording(config);
  }

  getAnalysisRecordingWaveform(): AnalysisRecordingWaveform {
    return this.native?.getAnalysisRecordingWaveform?.() ?? {
      durationMs: 0,
      totalSamples: 0,
      waveform: []
    };
  }

  stopAnalysisRecording(): RawAudioRecording {
    return this.native?.stopAnalysisRecording?.() ?? {
      sampleRate: DEFAULT_START_CONFIG.sampleRate,
      samples: []
    };
  }

  startLibraryRecording(config: AudioStartConfig): void {
    if (!this.native?.startAnalysisRecording) {
      throw new Error('Native audio library recording is unavailable.');
    }
    this.libraryRecording = true;
    this.native.startAnalysisRecording(config);
    this.latestStatus = {
      ...this.latestStatus,
      message: 'Recording input to Playback library.'
    };
  }

  getLibraryRecordingWaveform(): AnalysisRecordingWaveform {
    if (!this.libraryRecording) {
      return {
        durationMs: 0,
        totalSamples: 0,
        waveform: []
      };
    }
    return this.getAnalysisRecordingWaveform();
  }

  stopLibraryRecording(): RawAudioRecording {
    this.libraryRecording = false;
    return this.stopAnalysisRecording();
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
      // Keep trying other paths; playback can still run through the renderer.
    }
  }

  return null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
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

import type { AudioFeatures, AudioLibraryItem, AudioParamsUpdate, AudioStartConfig, GuitarTechnique } from '../shared/audio';
import { DEFAULT_FEATURES, DEFAULT_START_CONFIG } from '../shared/audio';

type PlaybackParams = Pick<AudioStartConfig, 'inputGain' | 'gateThreshold'>;

export type PlaybackTransportState = {
  itemId: string | null;
  itemName: string | null;
  loaded: boolean;
  playing: boolean;
  durationMs: number;
  positionMs: number;
  waveform: number[];
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const GUITAR_STRINGS = [
  { stringNumber: 6, midi: 40 },
  { stringNumber: 5, midi: 45 },
  { stringNumber: 4, midi: 50 },
  { stringNumber: 3, midi: 55 },
  { stringNumber: 2, midi: 59 },
  { stringNumber: 1, midi: 64 }
];

export class PlaybackFeatureEngine {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private item: AudioLibraryItem | null = null;
  private startedAt = 0;
  private pausedAt = 0;
  private playing = false;
  private waveform: number[] = [];
  private stateListeners = new Set<(state: PlaybackTransportState) => void>();
  private params: PlaybackParams = {
    inputGain: DEFAULT_START_CONFIG.inputGain,
    gateThreshold: DEFAULT_START_CONFIG.gateThreshold
  };
  private timeData = new Float32Array(2048);
  private freqData = new Uint8Array(1024);
  private previousRms = 0;
  private previousLow = 0;
  private previousMid = 0;
  private previousHigh = 0;
  private previousPitch: number | null = null;
  private stablePitch: number | null = null;
  private noteStability = 0;
  private recentBends: number[] = [];
  private lastEventAt = 0;
  private eventId = 1;

  get active(): boolean {
    return this.playing;
  }

  get hasSession(): boolean {
    return Boolean(this.item && this.buffer);
  }

  getState(): PlaybackTransportState {
    const duration = this.buffer?.duration ?? 0;
    return {
      itemId: this.item?.id ?? null,
      itemName: this.item?.name ?? null,
      loaded: Boolean(this.item && this.buffer),
      playing: this.playing,
      durationMs: duration * 1000,
      positionMs: this.getPositionSeconds() * 1000,
      waveform: this.waveform
    };
  }

  subscribe(listener: (state: PlaybackTransportState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  async load(item: AudioLibraryItem, params: PlaybackParams = this.params): Promise<void> {
    this.params = params;
    this.context = this.context ?? new AudioContext();
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    if (this.item?.id === item.id && this.buffer) {
      this.notifyState();
      return;
    }

    this.stopSource();
    this.resetAnalysisState();
    this.item = item;
    this.buffer = null;
    this.waveform = [];
    this.pausedAt = 0;
    this.notifyState();

    const response = await fetch(item.fileUrl);
    if (!response.ok) {
      this.item = null;
      this.notifyState();
      throw new Error(`Unable to load ${item.name}.`);
    }

    this.buffer = await this.context.decodeAudioData(await response.arrayBuffer());
    this.waveform = createWaveformOverview(this.buffer, 240);
    this.notifyState();
  }

  async start(item: AudioLibraryItem, params: PlaybackParams): Promise<void> {
    await this.load(item, params);
    await this.play();
  }

  async play(): Promise<void> {
    if (!this.context || !this.buffer) {
      return;
    }

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    this.stopSource();
    if (this.pausedAt >= this.buffer.duration) {
      this.pausedAt = 0;
    }
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.42;
    this.gain = this.context.createGain();
    this.gain.gain.value = 1;
    this.source = this.context.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.gain);
    this.gain.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this.source.onended = () => {
      if (!this.playing) {
        return;
      }
      this.pausedAt = this.buffer?.duration ?? 0;
      this.playing = false;
      this.notifyState();
    };
    this.startedAt = this.context.currentTime - this.pausedAt;
    this.playing = true;
    this.resetAnalysisState();
    this.source.start(0, this.pausedAt);
    this.notifyState();
  }

  pause(): void {
    if (!this.playing) {
      return;
    }

    this.pausedAt = this.getPositionSeconds();
    this.playing = false;
    this.stopSource();
    this.notifyState();
  }

  reset(): void {
    this.pausedAt = 0;
    this.playing = false;
    this.stopSource();
    this.resetAnalysisState();
    this.notifyState();
  }

  stop(): void {
    this.reset();
    this.buffer = null;
    this.item = null;
    this.waveform = [];
    this.notifyState();
  }

  private stopSource(): void {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        // The source may already have ended.
      }
      this.source.disconnect();
    }
    this.gain?.disconnect();
    this.analyser?.disconnect();
    this.source = null;
    this.gain = null;
    this.analyser = null;
  }

  setParams(update: AudioParamsUpdate): void {
    this.params = {
      inputGain: validParam(update.inputGain) ?? this.params.inputGain,
      gateThreshold: validParam(update.gateThreshold) ?? this.params.gateThreshold
    };
  }

  getLatestFeatures(): AudioFeatures {
    if (!this.playing || !this.context || !this.analyser || !this.buffer) {
      return DEFAULT_FEATURES;
    }

    if (this.context.currentTime - this.startedAt >= this.buffer.duration) {
      this.playing = false;
      this.pausedAt = this.buffer.duration;
      this.notifyState();
      return DEFAULT_FEATURES;
    }

    this.analyser.getFloatTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);
    const t = this.context.currentTime - this.startedAt;
    const sampleRate = this.context.sampleRate;
    const rmsRaw = rms(this.timeData);
    const rmsValue = clamp01(rmsRaw * this.params.inputGain);
    const peak = clamp01(peakAbs(this.timeData) * this.params.inputGain);
    const lowRaw = bandMean(this.freqData, 70, 260, sampleRate);
    const midRaw = bandMean(this.freqData, 260, 1800, sampleRate);
    const highRaw = bandMean(this.freqData, 1800, 7200, sampleRate);
    const bandTotal = Math.max(0.000001, lowRaw + midRaw + highRaw);
    const low = clamp01(lowRaw / bandTotal + rmsValue * 0.12);
    const mid = clamp01(midRaw / bandTotal + rmsValue * 0.08);
    const high = clamp01(highRaw / bandTotal + rmsValue * 0.06);
    const spectralCentroid = clamp01(frequencyCentroid(this.freqData, sampleRate) / 6500);
    const spectralRolloff = clamp01(rolloffFrequency(this.freqData, sampleRate) / 9000);
    const spectralFlatness = spectralFlatnessForBins(this.freqData);
    const zeroCrossingRate = clamp01(countZeroCrossings(this.timeData) / this.timeData.length * 7);
    const spectralFlux = clamp01((Math.max(0, low - this.previousLow) + Math.max(0, mid - this.previousMid) + Math.max(0, high - this.previousHigh)) * 1.85);
    const onset = clamp01(Math.max(0, rmsValue - this.previousRms) * 8 + spectralFlux * 0.66);
    const attack = clamp01(Math.max(0, rmsValue - this.previousRms) * 10 + spectralFlux * 0.72);
    const decay = clamp01(Math.max(0, this.previousRms - rmsValue) * 7);
    const pitch = estimatePitch(this.timeData, sampleRate, rmsRaw);
    const pitchHz = pitch?.hz ?? this.previousPitch;
    const pitchConfidence = pitch?.confidence ?? (this.previousPitch ? this.noteStability * 0.72 : 0);

    if (pitch && pitch.confidence > 0.18) {
      if (this.previousPitch) {
        const cents = Math.abs(1200 * Math.log2(pitch.hz / this.previousPitch));
        this.noteStability = clamp01(this.noteStability * 0.9 + (1 - Math.min(1, cents / 55)) * pitch.confidence * 0.1);
      } else {
        this.noteStability = pitch.confidence * 0.5;
      }
      this.stablePitch = this.stablePitch ? this.stablePitch * 0.96 + pitch.hz * 0.04 : pitch.hz;
      this.previousPitch = pitch.hz;
    } else {
      this.noteStability *= 0.985;
    }

    const bendCents =
      this.stablePitch && pitchHz && pitchConfidence > 0.18 ? clampNumber(1200 * Math.log2(pitchHz / this.stablePitch), -180, 180) : 0;
    this.recentBends.push(bendCents);
    while (this.recentBends.length > 180) {
      this.recentBends.shift();
    }
    const bendRange = this.recentBends.length ? Math.max(...this.recentBends) - Math.min(...this.recentBends) : 0;
    const vibratoDepth = clamp01(bendRange / 140);
    const vibratoRate = clamp01(countSignChanges(this.recentBends, 3) / 16);
    const brightness = clamp01(high * 0.72 + spectralCentroid * 0.28);
    const noisiness = clamp01(spectralFlatness * 0.56 + zeroCrossingRate * 0.44);
    const harmonicRatio = clamp01((1 - spectralFlatness) * pitchConfidence);
    const harmonicDensity = clamp01(harmonicRatio * 0.45 + mid * 0.28 + low * 0.18 + pitchConfidence * 0.09);
    const chordConfidence = clamp01(harmonicDensity * mid * 1.2);
    const spectralContrast = clamp01((Math.max(low, mid, high) - Math.min(low, mid, high)) * 1.45);
    const pickNoise = clamp01(high * 0.42 + spectralFlux * 0.36 + spectralFlatness * 0.22);
    const muteAmount = clamp01(decay * 0.34 + spectralFlatness * 0.24 + high * 0.18 + spectralFlux * 0.12 - this.noteStability * 0.1);
    const gate = rmsValue > this.params.gateThreshold;
    const noteName = gate && pitchHz ? noteNameForPitch(pitchHz) : null;
    const fretted = gate && pitchHz ? inferStringFret(pitchHz, pitchConfidence) : null;
    const chroma = makeChroma(pitchHz, pitchConfidence, gate, this.freqData, sampleRate);
    const technique = getTechnique({ gate, onset, pickNoise, muteAmount, vibratoDepth, bendCents, harmonicRatio });
    const guitarEvents =
      gate && onset > 0.22 && t - this.lastEventAt > 0.08
        ? [
            {
              id: this.eventId++,
              t,
              type: pickNoise > 0.52 ? 'strum' : 'note_on',
              strength: clamp01(onset + attack * 0.42),
              noteName,
              pitchHz,
              stringNumber: fretted?.stringNumber ?? null,
              fretNumber: fretted?.fretNumber ?? null,
              chordName: null
            } as const
          ]
        : [];
    if (guitarEvents.length) {
      this.lastEventAt = t;
    }

    this.previousRms = rmsValue;
    this.previousLow = low;
    this.previousMid = mid;
    this.previousHigh = high;

    return {
      ...DEFAULT_FEATURES,
      t,
      rms: rmsValue,
      peak,
      low,
      mid,
      high,
      spectralCentroid,
      pitchHz: gate ? pitchHz ?? null : null,
      pitchConfidence: clamp01(pitchConfidence),
      noteName,
      noteStability: this.noteStability,
      onset,
      gate,
      clipping: peak > 0.96,
      chroma,
      spectralFlux,
      spectralRolloff,
      spectralFlatness,
      zeroCrossingRate,
      brightness,
      noisiness,
      attack,
      decay,
      bendCents,
      vibratoDepth,
      vibratoRate,
      harmonicDensity,
      chordConfidence,
      logSpectrum: makeLogSpectrum(this.freqData),
      spectralContrast,
      harmonicRatio,
      pickNoise,
      muteAmount,
      guitarTechnique: technique,
      guitarTechniqueConfidence: gate ? clamp01(Math.max(pickNoise, muteAmount, vibratoDepth, Math.abs(bendCents) / 180, harmonicRatio) * 0.68 + onset * 0.32) : 1,
      stringNumber: fretted?.stringNumber ?? null,
      fretNumber: fretted?.fretNumber ?? null,
      voicing: fretted && pitchHz ? [{ ...fretted, pitchClass: midiForPitch(pitchHz) % 12, confidence: pitchConfidence }] : [],
      guitarEvents
    };
  }

  private getPositionSeconds(): number {
    const duration = this.buffer?.duration ?? 0;
    const position = this.playing && this.context ? this.context.currentTime - this.startedAt : this.pausedAt;
    return clampNumber(position, 0, duration);
  }

  private resetAnalysisState(): void {
    this.previousRms = 0;
    this.previousLow = 0;
    this.previousMid = 0;
    this.previousHigh = 0;
    this.previousPitch = null;
    this.stablePitch = null;
    this.noteStability = 0;
    this.recentBends = [];
    this.lastEventAt = 0;
  }

  private notifyState(): void {
    const state = this.getState();
    this.stateListeners.forEach((listener) => listener(state));
  }
}

function createWaveformOverview(buffer: AudioBuffer, pointCount: number): number[] {
  const samples = buffer.length;
  if (!samples) {
    return [];
  }

  return Array.from({ length: pointCount }, (_, index) => {
    const start = Math.floor((index / pointCount) * samples);
    const end = Math.max(start + 1, Math.floor(((index + 1) / pointCount) * samples));
    let peak = 0;
    for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex++) {
      const channel = buffer.getChannelData(channelIndex);
      for (let sampleIndex = start; sampleIndex < end; sampleIndex++) {
        peak = Math.max(peak, Math.abs(channel[sampleIndex] ?? 0));
      }
    }
    return clamp01(peak);
  });
}

function rms(values: Float32Array): number {
  let sum = 0;
  for (const value of values) {
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, values.length));
}

function peakAbs(values: Float32Array): number {
  let peak = 0;
  for (const value of values) {
    peak = Math.max(peak, Math.abs(value));
  }
  return peak;
}

function bandMean(values: Uint8Array, minHz: number, maxHz: number, sampleRate: number): number {
  const nyquist = sampleRate / 2;
  const start = Math.max(0, Math.floor((minHz / nyquist) * values.length));
  const end = Math.min(values.length, Math.ceil((maxHz / nyquist) * values.length));
  let sum = 0;
  for (let index = start; index < end; index += 1) {
    sum += (values[index] ?? 0) / 255;
  }
  return sum / Math.max(1, end - start);
}

function frequencyCentroid(values: Uint8Array, sampleRate: number): number {
  const nyquist = sampleRate / 2;
  let weighted = 0;
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    const magnitude = values[index] ?? 0;
    const frequency = (index / values.length) * nyquist;
    weighted += frequency * magnitude;
    total += magnitude;
  }
  return total > 0 ? weighted / total : 0;
}

function rolloffFrequency(values: Uint8Array, sampleRate: number): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  const threshold = total * 0.85;
  let cumulative = 0;
  for (let index = 0; index < values.length; index += 1) {
    cumulative += values[index] ?? 0;
    if (cumulative >= threshold) {
      return (index / values.length) * (sampleRate / 2);
    }
  }
  return 0;
}

function spectralFlatnessForBins(values: Uint8Array): number {
  let logSum = 0;
  let sum = 0;
  let count = 0;
  for (let index = 1; index < values.length; index += 4) {
    const magnitude = (values[index] ?? 0) / 255 + 0.000001;
    logSum += Math.log(magnitude);
    sum += magnitude;
    count += 1;
  }
  return clamp01(Math.exp(logSum / Math.max(1, count)) / Math.max(0.000001, sum / Math.max(1, count)));
}

function countZeroCrossings(values: Float32Array): number {
  let count = 0;
  for (let index = 1; index < values.length; index += 1) {
    const prev = values[index - 1] ?? 0;
    const next = values[index] ?? 0;
    if ((prev >= 0 && next < 0) || (prev < 0 && next >= 0)) {
      count += 1;
    }
  }
  return count;
}

function estimatePitch(values: Float32Array, sampleRate: number, rmsValue: number): { hz: number; confidence: number } | null {
  if (rmsValue < 0.006) {
    return null;
  }
  const minLag = Math.floor(sampleRate / 1200);
  const maxLag = Math.min(Math.floor(sampleRate / 60), Math.floor(values.length / 2));
  let bestLag = 0;
  let bestCorrelation = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    let energyA = 0;
    let energyB = 0;
    for (let index = 0; index < values.length - lag; index += 1) {
      const a = values[index] ?? 0;
      const b = values[index + lag] ?? 0;
      sum += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const correlation = sum / Math.sqrt(Math.max(0.000001, energyA * energyB));
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  if (!bestLag || bestCorrelation < 0.18) {
    return null;
  }
  return {
    hz: sampleRate / bestLag,
    confidence: clamp01((bestCorrelation - 0.18) / 0.62)
  };
}

function makeChroma(pitchHz: number | null, confidence: number, gate: boolean, bins: Uint8Array, sampleRate: number): number[] {
  const chroma = Array.from({ length: 12 }, () => 0.015);
  if (!gate) {
    return chroma;
  }
  if (pitchHz && confidence > 0.14) {
    const pitchClass = midiForPitch(pitchHz) % 12;
    chroma[pitchClass] = clamp01(0.35 + confidence * 0.65);
    chroma[(pitchClass + 7) % 12] = Math.max(chroma[(pitchClass + 7) % 12] ?? 0, confidence * 0.28);
  }
  const nyquist = sampleRate / 2;
  for (let index = 2; index < bins.length; index += 8) {
    const magnitude = (bins[index] ?? 0) / 255;
    if (magnitude < 0.18) {
      continue;
    }
    const hz = (index / bins.length) * nyquist;
    if (hz < 70 || hz > 2200) {
      continue;
    }
    const pitchClass = midiForPitch(hz) % 12;
    chroma[pitchClass] = clamp01((chroma[pitchClass] ?? 0) + magnitude * 0.08);
  }
  return chroma;
}

function makeLogSpectrum(values: Uint8Array): number[] {
  return Array.from({ length: 36 }, (_, bucket) => {
    const start = Math.floor((bucket / 36) ** 1.65 * values.length);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) / 36) ** 1.65 * values.length));
    let peak = 0;
    for (let index = start; index < Math.min(values.length, end); index += 1) {
      peak = Math.max(peak, (values[index] ?? 0) / 255);
    }
    return clamp01(peak);
  });
}

function getTechnique(values: {
  gate: boolean;
  onset: number;
  pickNoise: number;
  muteAmount: number;
  vibratoDepth: number;
  bendCents: number;
  harmonicRatio: number;
}): GuitarTechnique {
  if (!values.gate) {
    return 'idle';
  }
  if (Math.abs(values.bendCents) > 35) {
    return 'bend';
  }
  if (values.vibratoDepth > 0.24) {
    return 'vibrato';
  }
  if (values.muteAmount > 0.42) {
    return 'palm_mute';
  }
  if (values.pickNoise > 0.54) {
    return 'strum';
  }
  if (values.onset > 0.24) {
    return 'single_note';
  }
  return values.harmonicRatio > 0.42 ? 'sustain' : 'noise';
}

function inferStringFret(pitchHz: number, confidence: number): { stringNumber: number; fretNumber: number } | null {
  if (confidence < 0.12) {
    return null;
  }
  const midi = midiForPitch(pitchHz);
  let best: { stringNumber: number; fretNumber: number; distance: number } | null = null;
  for (const string of GUITAR_STRINGS) {
    const fret = midi - string.midi;
    if (fret < 0 || fret > 24) {
      continue;
    }
    const distance = Math.abs(fret - 7);
    if (!best || distance < best.distance) {
      best = { stringNumber: string.stringNumber, fretNumber: Math.round(fret), distance };
    }
  }
  return best ? { stringNumber: best.stringNumber, fretNumber: best.fretNumber } : null;
}

function noteNameForPitch(hz: number): string {
  const midi = midiForPitch(hz);
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${octave}`;
}

function midiForPitch(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

function countSignChanges(values: number[], deadZone: number): number {
  let changes = 0;
  let lastSign = 0;
  for (const value of values) {
    if (Math.abs(value) <= deadZone) {
      continue;
    }
    const sign = Math.sign(value);
    if (lastSign !== 0 && sign !== lastSign) {
      changes += 1;
    }
    lastSign = sign;
  }
  return changes;
}

function validParam(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clamp01(value: number): number {
  return clampNumber(value, 0, 1);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

export type ActivityMetricKey =
  | 'rms'
  | 'peak'
  | 'low'
  | 'mid'
  | 'high'
  | 'spectralCentroid'
  | 'pitchHz'
  | 'pitchConfidence'
  | 'noteStability'
  | 'onset'
  | 'spectralFlux'
  | 'spectralRolloff'
  | 'spectralFlatness'
  | 'zeroCrossingRate'
  | 'brightness'
  | 'noisiness'
  | 'attack'
  | 'decay'
  | 'pickNoise'
  | 'muteAmount'
  | 'harmonicRatio'
  | 'bendCents'
  | 'vibratoDepth'
  | 'vibratoRate'
  | 'harmonicDensity'
  | 'chordConfidence'
  | 'spectrum'
  | 'spectralContrast'
  | 'guitarTechniqueConfidence';

export type ActivityMetricDefinition = {
  key: ActivityMetricKey;
  label: string;
  min: number;
  max: number;
};

export type ActivityMetricResult = {
  key: ActivityMetricKey;
  label: string;
  score: number;
  min: number;
  max: number;
  mean: number;
  variance: number;
  samples: number;
  sparkline: number[];
};

export type ActivityAnalysisReport = {
  durationMs: number;
  sampleRate: number;
  waveform: number[];
  rankings: ActivityMetricResult[];
};

type AudioRecording = {
  samples: Float32Array;
  sampleRate: number;
};

type FrameAccumulator = Record<ActivityMetricKey, number[]>;

const FFT_WINDOW_SIZE = 2048;
const ACTIVITY_DEAD_ZONE = 0.0025;
const SPARKLINE_POINTS = 72;
const WAVEFORM_POINTS = 180;

const METRICS: ActivityMetricDefinition[] = [
  { key: 'rms', label: 'RMS', min: 0, max: 1 },
  { key: 'peak', label: 'Peak', min: 0, max: 1 },
  { key: 'low', label: 'Low', min: 0, max: 1 },
  { key: 'mid', label: 'Mid', min: 0, max: 1 },
  { key: 'high', label: 'High', min: 0, max: 1 },
  { key: 'spectralCentroid', label: 'Centroid', min: 0, max: 1 },
  { key: 'pitchHz', label: 'Pitch Hz', min: 0, max: 1200 },
  { key: 'pitchConfidence', label: 'Pitch', min: 0, max: 1 },
  { key: 'noteStability', label: 'Stable', min: 0, max: 1 },
  { key: 'onset', label: 'Onset', min: 0, max: 1 },
  { key: 'spectralFlux', label: 'Flux', min: 0, max: 1 },
  { key: 'spectralRolloff', label: 'Rolloff', min: 0, max: 1 },
  { key: 'spectralFlatness', label: 'Flat', min: 0, max: 1 },
  { key: 'zeroCrossingRate', label: 'Zero X', min: 0, max: 1 },
  { key: 'brightness', label: 'Bright', min: 0, max: 1 },
  { key: 'noisiness', label: 'Noise', min: 0, max: 1 },
  { key: 'attack', label: 'Attack', min: 0, max: 1 },
  { key: 'decay', label: 'Decay', min: 0, max: 1 },
  { key: 'pickNoise', label: 'Pick', min: 0, max: 1 },
  { key: 'muteAmount', label: 'Mute', min: 0, max: 1 },
  { key: 'harmonicRatio', label: 'Harm', min: 0, max: 1 },
  { key: 'bendCents', label: 'Bend', min: -180, max: 180 },
  { key: 'vibratoDepth', label: 'Vib', min: 0, max: 1 },
  { key: 'vibratoRate', label: 'Vib Rate', min: 0, max: 1 },
  { key: 'harmonicDensity', label: 'Harm Dens', min: 0, max: 1 },
  { key: 'chordConfidence', label: 'Chord Conf', min: 0, max: 1 },
  { key: 'spectrum', label: 'Spectrum', min: 0, max: 1 },
  { key: 'spectralContrast', label: 'Contrast', min: 0, max: 1 },
  { key: 'guitarTechniqueConfidence', label: 'Tech Conf', min: 0, max: 1 }
];

export function createWaveformPreview(samples: Float32Array, pointCount = WAVEFORM_POINTS): number[] {
  if (!samples.length) {
    return [];
  }

  const bucketSize = Math.max(1, Math.floor(samples.length / pointCount));
  const waveform: number[] = [];
  for (let start = 0; start < samples.length; start += bucketSize) {
    let peak = 0;
    const end = Math.min(samples.length, start + bucketSize);
    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    }
    waveform.push(clamp01(peak));
  }
  return waveform.slice(-pointCount);
}

export async function analyzeAudioRecording(recording: AudioRecording): Promise<ActivityAnalysisReport> {
  const samples = recording.samples;
  const sampleRate = recording.sampleRate;
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  const frameCount = Math.max(1, Math.floor(durationMs));
  const stepSamples = Math.max(1, Math.round(sampleRate / 1000));
  const windowSamples = Math.min(samples.length, Math.max(256, Math.min(FFT_WINDOW_SIZE, Math.round(sampleRate * 0.032))));
  const filtered = await createFilteredBuffers(samples, sampleRate);
  const rawEnergy = prefixSquares(samples);
  const lowEnergy = prefixSquares(filtered.low);
  const midEnergy = prefixSquares(filtered.mid);
  const highEnergy = prefixSquares(filtered.high);
  const pickEnergy = prefixSquares(filtered.pick);
  const zeroCrossings = prefixZeroCrossings(samples);
  const frames = createFrameAccumulator();
  let previousRms = 0;
  let previousLow = 0;
  let previousMid = 0;
  let previousHigh = 0;
  let previousPitch: number | null = null;
  let stablePitch: number | null = null;
  let noteStability = 0;
  const recentBends: number[] = [];

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const center = frameIndex * stepSamples;
    const start = Math.max(0, Math.min(samples.length - 1, center - Math.floor(windowSamples / 2)));
    const end = Math.max(start + 1, Math.min(samples.length, start + windowSamples));
    const rms = rmsFromPrefix(rawEnergy, start, end);
    const peak = peakInRange(samples, start, end);
    const low = rmsFromPrefix(lowEnergy, start, end);
    const mid = rmsFromPrefix(midEnergy, start, end);
    const high = rmsFromPrefix(highEnergy, start, end);
    const pick = rmsFromPrefix(pickEnergy, start, end);
    const bandTotal = Math.max(0.000001, low + mid + high);
    const normalizedLow = clamp01(low / bandTotal);
    const normalizedMid = clamp01(mid / bandTotal);
    const normalizedHigh = clamp01(high / bandTotal);
    const zeroCrossingRate = clamp01((zeroCrossings[end] - zeroCrossings[start]) / Math.max(1, end - start) * 8);
    const spectralCentroid = clamp01((normalizedLow * 110 + normalizedMid * 900 + normalizedHigh * 4000) / 5000);
    const spectralRolloff = clamp01((normalizedHigh * 0.72 + normalizedMid * 0.25 + normalizedLow * 0.06) * 1.25);
    const spectralFlatness = spectralFlatness3(normalizedLow, normalizedMid, normalizedHigh);
    const brightness = clamp01(normalizedHigh * 0.72 + spectralCentroid * 0.28);
    const noisiness = clamp01(spectralFlatness * 0.56 + zeroCrossingRate * 0.44);
    const spectralFlux = clamp01(
      (Math.max(0, normalizedLow - previousLow) +
        Math.max(0, normalizedMid - previousMid) +
        Math.max(0, normalizedHigh - previousHigh)) *
        1.9
    );
    const onset = clamp01(Math.max(0, rms - previousRms) * 8 + spectralFlux * 0.62);
    const attack = clamp01(Math.max(0, rms - previousRms) * 10 + spectralFlux * 0.72);
    const decay = clamp01(Math.max(0, previousRms - rms) * 7);
    const pitch = frameIndex % 10 === 0 ? estimatePitch(samples, start, end, sampleRate, rms) : null;
    const pitchHz = pitch?.hz ?? previousPitch ?? 0;
    const pitchConfidence = pitch?.confidence ?? (previousPitch ? Math.max(0, noteStability * 0.72) : 0);

    if (pitch && pitch.confidence > 0.18) {
      if (previousPitch) {
        const cents = Math.abs(1200 * Math.log2(pitch.hz / previousPitch));
        noteStability = clamp01(noteStability * 0.9 + (1 - Math.min(1, cents / 55)) * pitch.confidence * 0.1);
      } else {
        noteStability = pitch.confidence * 0.5;
      }
      stablePitch = stablePitch ? stablePitch * 0.96 + pitch.hz * 0.04 : pitch.hz;
      previousPitch = pitch.hz;
    } else {
      noteStability *= 0.985;
    }

    const bendCents =
      stablePitch && pitchHz > 0 && pitchConfidence > 0.18 ? clampNumber(1200 * Math.log2(pitchHz / stablePitch), -180, 180) : 0;
    recentBends.push(bendCents);
    while (recentBends.length > 180) {
      recentBends.shift();
    }
    const bendRange = recentBends.length ? Math.max(...recentBends) - Math.min(...recentBends) : 0;
    const vibratoDepth = clamp01(bendRange / 140);
    const vibratoRate = clamp01(countSignChanges(recentBends, 3) / 16);
    const harmonicRatio = clamp01((1 - spectralFlatness) * pitchConfidence);
    const harmonicDensity = clamp01(harmonicRatio * 0.45 + normalizedMid * 0.28 + normalizedLow * 0.18 + pitchConfidence * 0.09);
    const chordConfidence = clamp01(harmonicDensity * normalizedMid * 1.2);
    const spectrum = clamp01((normalizedLow + normalizedMid + normalizedHigh) / 3 + rms * 0.22);
    const spectralContrast = clamp01((Math.max(normalizedLow, normalizedMid, normalizedHigh) - Math.min(normalizedLow, normalizedMid, normalizedHigh)) * 1.45);
    const pickNoise = clamp01((pick / Math.max(0.000001, bandTotal)) * 0.7 + spectralFlux * 0.2 + brightness * 0.1);
    const muteAmount = clamp01(decay * 0.34 + spectralFlatness * 0.24 + normalizedHigh * 0.18 + spectralFlux * 0.12 - noteStability * 0.1);
    const guitarTechniqueConfidence = clamp01(
      Math.max(pickNoise, muteAmount, vibratoDepth, Math.abs(bendCents) / 180, chordConfidence, harmonicRatio) * 0.68 + onset * 0.32
    );

    frames.rms.push(clamp01(rms));
    frames.peak.push(clamp01(peak));
    frames.low.push(normalizedLow);
    frames.mid.push(normalizedMid);
    frames.high.push(normalizedHigh);
    frames.spectralCentroid.push(spectralCentroid);
    frames.pitchHz.push(pitchHz);
    frames.pitchConfidence.push(clamp01(pitchConfidence));
    frames.noteStability.push(noteStability);
    frames.onset.push(onset);
    frames.spectralFlux.push(spectralFlux);
    frames.spectralRolloff.push(spectralRolloff);
    frames.spectralFlatness.push(spectralFlatness);
    frames.zeroCrossingRate.push(zeroCrossingRate);
    frames.brightness.push(brightness);
    frames.noisiness.push(noisiness);
    frames.attack.push(attack);
    frames.decay.push(decay);
    frames.pickNoise.push(pickNoise);
    frames.muteAmount.push(muteAmount);
    frames.harmonicRatio.push(harmonicRatio);
    frames.bendCents.push(bendCents);
    frames.vibratoDepth.push(vibratoDepth);
    frames.vibratoRate.push(vibratoRate);
    frames.harmonicDensity.push(harmonicDensity);
    frames.chordConfidence.push(chordConfidence);
    frames.spectrum.push(spectrum);
    frames.spectralContrast.push(spectralContrast);
    frames.guitarTechniqueConfidence.push(guitarTechniqueConfidence);

    previousRms = rms;
    previousLow = normalizedLow;
    previousMid = normalizedMid;
    previousHigh = normalizedHigh;
  }

  return {
    durationMs,
    sampleRate,
    waveform: createWaveformPreview(samples),
    rankings: METRICS.map((metric) => summarizeMetric(metric, frames[metric.key])).sort((a, b) => b.score - a.score)
  };
}

function createFrameAccumulator(): FrameAccumulator {
  return METRICS.reduce((accumulator, metric) => {
    accumulator[metric.key] = [];
    return accumulator;
  }, {} as FrameAccumulator);
}

async function createFilteredBuffers(samples: Float32Array, sampleRate: number) {
  try {
    const [low, mid, high, pick] = await Promise.all([
      renderBiquad(samples, sampleRate, 'lowpass', 220, 0.707),
      renderBiquad(samples, sampleRate, 'bandpass', 850, 0.82),
      renderBiquad(samples, sampleRate, 'highpass', 1600, 0.707),
      renderBiquad(samples, sampleRate, 'highpass', 3200, 0.707)
    ]);
    return { low, mid, high, pick };
  } catch {
    return { low: samples, mid: samples, high: samples, pick: samples };
  }
}

async function renderBiquad(samples: Float32Array, sampleRate: number, type: BiquadFilterType, frequency: number, q: number): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, samples.length, sampleRate);
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(new Float32Array(samples), 0);
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  source.buffer = buffer;
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  source.connect(filter);
  filter.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

function summarizeMetric(metric: ActivityMetricDefinition, values: number[]): ActivityMetricResult {
  const normalized = values.map((value) => normalizeMetricValue(metric, value));
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let sumSquares = 0;
  let movement = 0;
  let activeDeltas = 0;
  let directionChanges = 0;
  let lastDirection = 0;
  let normalizedMin = Number.POSITIVE_INFINITY;
  let normalizedMax = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    const normalizedValue = normalized[index] ?? 0;
    min = Math.min(min, value);
    max = Math.max(max, value);
    normalizedMin = Math.min(normalizedMin, normalizedValue);
    normalizedMax = Math.max(normalizedMax, normalizedValue);
    sum += value;
    sumSquares += value * value;

    if (index > 0) {
      const delta = (normalized[index] ?? 0) - (normalized[index - 1] ?? 0);
      const magnitude = Math.abs(delta);
      if (magnitude > ACTIVITY_DEAD_ZONE) {
        movement += magnitude - ACTIVITY_DEAD_ZONE;
        activeDeltas += 1;
        const direction = Math.sign(delta);
        if (lastDirection !== 0 && direction !== lastDirection) {
          directionChanges += 1;
        }
        lastDirection = direction;
      }
    }
  }

  const samples = values.length;
  const mean = samples ? sum / samples : 0;
  const variance = samples ? Math.max(0, sumSquares / samples - mean * mean) : 0;
  const range = normalized.length ? normalizedMax - normalizedMin : 0;
  const meanMovement = samples > 1 ? movement / (samples - 1) : 0;
  const movementScore = clamp01(meanMovement / 0.012);
  const backAndForthScore = activeDeltas ? clamp01(directionChanges / activeDeltas) : 0;
  const varianceScore = clamp01(Math.sqrt(variance) / Math.max(0.000001, metric.max - metric.min) * 2.5);
  const score = Math.round((range * 0.3 + movementScore * 0.4 + backAndForthScore * 0.2 + varianceScore * 0.1) * 1000) / 10;

  return {
    key: metric.key,
    label: metric.label,
    score: clampNumber(score, 0, 100),
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
    mean,
    variance,
    samples,
    sparkline: bucketSeries(normalized, SPARKLINE_POINTS, isTransientMetric(metric.key) ? 'peak' : 'mean')
  };
}

function normalizeMetricValue(metric: ActivityMetricDefinition, value: number): number {
  return clamp01((value - metric.min) / Math.max(0.000001, metric.max - metric.min));
}

function isTransientMetric(key: ActivityMetricKey): boolean {
  return key === 'onset' || key === 'attack' || key === 'decay' || key === 'spectralFlux' || key === 'pickNoise';
}

function bucketSeries(values: number[], pointCount: number, mode: 'mean' | 'peak' = 'mean'): number[] {
  if (!values.length) {
    return [];
  }

  const bucketSize = Math.max(1, Math.ceil(values.length / pointCount));
  const buckets: number[] = [];
  for (let start = 0; start < values.length; start += bucketSize) {
    const end = Math.min(values.length, start + bucketSize);
    let sum = 0;
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const value = values[index] ?? 0;
      sum += value;
      peak = Math.max(peak, value);
    }
    buckets.push(clamp01(mode === 'peak' ? peak : sum / Math.max(1, end - start)));
  }
  return buckets;
}

function prefixSquares(samples: Float32Array): Float64Array {
  const prefix = new Float64Array(samples.length + 1);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    prefix[index + 1] = prefix[index] + sample * sample;
  }
  return prefix;
}

function prefixZeroCrossings(samples: Float32Array): Uint32Array {
  const prefix = new Uint32Array(samples.length + 1);
  for (let index = 1; index < samples.length; index += 1) {
    const prev = samples[index - 1] ?? 0;
    const next = samples[index] ?? 0;
    prefix[index + 1] = prefix[index] + ((prev >= 0 && next < 0) || (prev < 0 && next >= 0) ? 1 : 0);
  }
  return prefix;
}

function rmsFromPrefix(prefix: Float64Array, start: number, end: number): number {
  return Math.sqrt((prefix[end] - prefix[start]) / Math.max(1, end - start));
}

function peakInRange(samples: Float32Array, start: number, end: number): number {
  let peak = 0;
  for (let index = start; index < end; index += 1) {
    peak = Math.max(peak, Math.abs(samples[index] ?? 0));
  }
  return peak;
}

function spectralFlatness3(low: number, mid: number, high: number): number {
  const a = low + 0.000001;
  const b = mid + 0.000001;
  const c = high + 0.000001;
  const geometric = Math.cbrt(a * b * c);
  const arithmetic = (a + b + c) / 3;
  return clamp01(geometric / Math.max(0.000001, arithmetic));
}

function estimatePitch(samples: Float32Array, start: number, end: number, sampleRate: number, rms: number): { hz: number; confidence: number } | null {
  if (rms < 0.006) {
    return null;
  }

  const minLag = Math.floor(sampleRate / 1200);
  const maxLag = Math.min(Math.floor(sampleRate / 60), Math.floor((end - start) / 2));
  let bestLag = 0;
  let bestCorrelation = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    let energyA = 0;
    let energyB = 0;
    for (let index = start; index < end - lag; index += 1) {
      const a = samples[index] ?? 0;
      const b = samples[index + lag] ?? 0;
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

function clamp01(value: number): number {
  return clampNumber(value, 0, 1);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

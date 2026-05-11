export type AudioMode = 'live' | 'simulator';

export type AudioDevice = {
  id: string;
  name: string;
  host: string;
  inputChannels: number;
  defaultSampleRate: number;
  supportedSampleRates: number[];
  isDefault: boolean;
};

export type AudioStartConfig = {
  mode: AudioMode;
  deviceId?: string;
  channelIndex: number;
  sampleRate: 48000;
  bufferSize: 128 | 256 | 512;
  featureRateHz: number;
  inputGain: number;
  gateThreshold: number;
};

export type AudioParamsUpdate = {
  inputGain?: number;
  gateThreshold?: number;
};

export type AudioFeatures = {
  t: number;
  rms: number;
  peak: number;
  low: number;
  mid: number;
  high: number;
  spectralCentroid: number;
  pitchHz: number | null;
  pitchConfidence: number;
  noteName: string | null;
  noteStability: number;
  onset: number;
  gate: boolean;
  clipping: boolean;
};

export type AudioStatus = {
  running: boolean;
  mode: AudioMode;
  message: string;
  nativeAvailable: boolean;
};

export type LayerState = {
  draw2d: boolean;
  draw3d: boolean;
};

export const DEFAULT_FEATURES: AudioFeatures = {
  t: 0,
  rms: 0,
  peak: 0,
  low: 0,
  mid: 0,
  high: 0,
  spectralCentroid: 0,
  pitchHz: null,
  pitchConfidence: 0,
  noteName: null,
  noteStability: 0,
  onset: 0,
  gate: false,
  clipping: false
};

export const DEFAULT_START_CONFIG: AudioStartConfig = {
  mode: 'live',
  channelIndex: 0,
  sampleRate: 48000,
  bufferSize: 256,
  featureRateHz: 120,
  inputGain: 1,
  gateThreshold: 0.025
};

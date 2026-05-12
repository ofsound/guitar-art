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
  chroma: number[];
  spectralFlux: number;
  spectralRolloff: number;
  spectralFlatness: number;
  zeroCrossingRate: number;
  brightness: number;
  noisiness: number;
  attack: number;
  decay: number;
  bendCents: number;
  vibratoDepth: number;
  vibratoRate: number;
  harmonicDensity: number;
  chordRoot: string | null;
  chordQuality: ChordQuality;
  chordName: string | null;
  chordConfidence: number;
};

export type ChordQuality = 'major' | 'minor' | 'power' | 'sus2' | 'sus4' | 'unknown' | null;

export type AudioStatus = {
  running: boolean;
  mode: AudioMode;
  message: string;
  nativeAvailable: boolean;
};

export type VisualLayerKind = '2d' | '3d';

export type VisualLayerMode = 'trails2d' | 'lineArt2d' | 'forms3d' | 'spectralField3d' | 'chromaConstellation3d';

export type VisualLayerControls = {
  sensitivity: number;
  smoothing: number;
  gateThreshold: number;
  motionAmount: number;
  scaleAmount: number;
  colorAmount: number;
  opacity: number;
  requiresGate: boolean;
};

export type VisualLayer = {
  id: string;
  name: string;
  kind: VisualLayerKind;
  mode: VisualLayerMode;
  enabled: boolean;
  controls: VisualLayerControls;
};

export type VisualLayerPreset = {
  id: string;
  name: string;
  layers: VisualLayer[];
  createdAt: number;
};

export type PngExportRequest = {
  dataUrl: string;
  suggestedName: string;
};

export type PngExportResult = {
  canceled: boolean;
  filePath?: string;
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
  clipping: false,
  chroma: Array.from({ length: 12 }, () => 0),
  spectralFlux: 0,
  spectralRolloff: 0,
  spectralFlatness: 0,
  zeroCrossingRate: 0,
  brightness: 0,
  noisiness: 0,
  attack: 0,
  decay: 0,
  bendCents: 0,
  vibratoDepth: 0,
  vibratoRate: 0,
  harmonicDensity: 0,
  chordRoot: null,
  chordQuality: null,
  chordName: null,
  chordConfidence: 0
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

export const DEFAULT_LAYER_CONTROLS: VisualLayerControls = {
  sensitivity: 1,
  smoothing: 0.35,
  gateThreshold: 0.025,
  motionAmount: 1,
  scaleAmount: 1,
  colorAmount: 1,
  opacity: 0.9,
  requiresGate: false
};

export const DEFAULT_VISUAL_LAYERS: VisualLayer[] = [
  {
    id: 'default-2d-trails',
    name: '2D Trails',
    kind: '2d',
    mode: 'trails2d',
    enabled: true,
    controls: { ...DEFAULT_LAYER_CONTROLS, opacity: 0.8 }
  },
  {
    id: 'default-3d-forms',
    name: '3D Forms',
    kind: '3d',
    mode: 'forms3d',
    enabled: true,
    controls: { ...DEFAULT_LAYER_CONTROLS, requiresGate: true, opacity: 0.95 }
  }
];

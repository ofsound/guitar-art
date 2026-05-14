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

export type RawAudioRecording = {
  sampleRate: number;
  samples: number[];
};

export type AnalysisRecordingWaveform = {
  durationMs: number;
  totalSamples: number;
  waveform: number[];
};

export type GuitarTechnique =
  | 'idle'
  | 'single_note'
  | 'strum'
  | 'palm_mute'
  | 'scrape'
  | 'noise'
  | 'sustain'
  | 'bend'
  | 'vibrato';

export type GuitarVoicingCandidate = {
  stringNumber: number;
  fretNumber: number;
  pitchClass: number;
  confidence: number;
};

export type GuitarEventType =
  | 'note_on'
  | 'note_off'
  | 'pluck'
  | 'strum'
  | 'chord_change'
  | 'bend'
  | 'vibrato'
  | 'mute'
  | 'noise';

export type GuitarEvent = {
  id: number;
  t: number;
  type: GuitarEventType;
  strength: number;
  noteName?: string | null;
  pitchHz?: number | null;
  stringNumber?: number | null;
  fretNumber?: number | null;
  chordName?: string | null;
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
  logSpectrum: number[];
  spectralContrast: number;
  harmonicRatio: number;
  pickNoise: number;
  muteAmount: number;
  guitarTechnique: GuitarTechnique;
  guitarTechniqueConfidence: number;
  stringNumber: number | null;
  fretNumber: number | null;
  voicing: GuitarVoicingCandidate[];
  guitarEvents: GuitarEvent[];
};

export type ChordQuality =
  | 'major'
  | 'minor'
  | 'power'
  | 'sus2'
  | 'sus4'
  | 'major7'
  | 'minor7'
  | 'dominant7'
  | 'add9'
  | 'dyad'
  | 'unknown'
  | null;

export type AudioStatus = {
  running: boolean;
  mode: AudioMode;
  message: string;
  nativeAvailable: boolean;
};

export type VisualLayerKind = '2d' | '3d';

export type VisualLayerMode =
  | 'trails2d'
  | 'lineArt2d'
  | 'fretPulse2d'
  | 'techniqueMap2d'
  | 'sideScroller2d'
  | 'forms3d'
  | 'spectralField3d'
  | 'chromaConstellation3d'
  | 'guitarGlyph3d'
  | 'stringResonator3d'
  | 'techniqueShard3d';

export type VisualLayerControls = {
  sensitivity: number;
  smoothing: number;
  gateThreshold: number;
  motionAmount: number;
  scaleAmount: number;
  colorAmount: number;
  opacity: number;
  requiresGate: boolean;
  trailFade?: number;
  trailSpeed?: number;
  brushSize?: number;
  bloom?: number;
  lineComplexity?: number;
  lineDrift?: number;
  lineWeight?: number;
  symmetry?: number;
  fretSpan?: number;
  stringWarp?: number;
  pulseDecay?: number;
  markerSize?: number;
  scrollSpeed?: number;
  laneGain?: number;
  historyFade?: number;
  eventAccent?: number;
  formScale?: number;
  morphRate?: number;
  spin?: number;
  particleBurst?: number;
  fieldSpread?: number;
  orbitSpeed?: number;
  pointSize?: number;
  density?: number;
  nodeScale?: number;
  chordTension?: number;
  particleBloom?: number;
  fretboardTilt?: number;
  noteGlow?: number;
  spectrumHeight?: number;
  stringCount?: number;
  resonanceDecay?: number;
  waveDepth?: number;
  bendSensitivity?: number;
  shardCount?: number;
  scatter?: number;
  fracture?: number;
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

export type MediaExportRequest = {
  dataUrl: string;
  suggestedName: string;
  mimeType: string;
  extension: 'png' | 'webm';
};

export type MediaExportResult = {
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
  chordConfidence: 0,
  logSpectrum: Array.from({ length: 36 }, () => 0),
  spectralContrast: 0,
  harmonicRatio: 0,
  pickNoise: 0,
  muteAmount: 0,
  guitarTechnique: 'idle',
  guitarTechniqueConfidence: 0,
  stringNumber: null,
  fretNumber: null,
  voicing: [],
  guitarEvents: []
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
  requiresGate: false,
  trailFade: 0.028,
  trailSpeed: 1.15,
  brushSize: 1,
  bloom: 1,
  lineComplexity: 1,
  lineDrift: 1,
  lineWeight: 1,
  symmetry: 1,
  fretSpan: 12,
  stringWarp: 1,
  pulseDecay: 1,
  markerSize: 1,
  scrollSpeed: 1,
  laneGain: 1,
  historyFade: 0.035,
  eventAccent: 1,
  formScale: 1,
  morphRate: 1,
  spin: 1,
  particleBurst: 1,
  fieldSpread: 1,
  orbitSpeed: 1,
  pointSize: 1,
  density: 1,
  nodeScale: 1,
  chordTension: 1,
  particleBloom: 1,
  fretboardTilt: 1,
  noteGlow: 1,
  spectrumHeight: 1,
  stringCount: 6,
  resonanceDecay: 1,
  waveDepth: 1,
  bendSensitivity: 1,
  shardCount: 1,
  scatter: 1,
  fracture: 1
};

export const DEFAULT_VISUAL_LAYERS: VisualLayer[] = [
  {
    id: 'default-2d-trails',
    name: '2D Trails',
    kind: '2d',
    mode: 'trails2d',
    enabled: true,
    controls: { ...DEFAULT_LAYER_CONTROLS, opacity: 0.8, trailFade: 0.018, trailSpeed: 1.35, brushSize: 1.1, bloom: 1.25 }
  },
  {
    id: 'default-3d-forms',
    name: '3D Forms',
    kind: '3d',
    mode: 'forms3d',
    enabled: true,
    controls: { ...DEFAULT_LAYER_CONTROLS, requiresGate: true, opacity: 0.95, formScale: 1.1, morphRate: 1.15, spin: 0.9, particleBurst: 1.2 }
  }
];

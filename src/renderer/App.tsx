import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AudioDevice,
  AudioMode,
  AudioStartConfig,
  AudioStatus,
  VisualLayer,
  VisualLayerControls,
  VisualLayerKind,
  VisualLayerMode,
  VisualLayerPreset
} from '../shared/audio';
import { DEFAULT_LAYER_CONTROLS, DEFAULT_START_CONFIG, DEFAULT_VISUAL_LAYERS } from '../shared/audio';
import { getArtClient, getAudioClient } from './audioClient';
import { useAudioFeatures } from './useAudioFeatures';
import { VisualSynth } from './VisualSynth';
import type { VisualCaptureOptions, VisualRecordingResult, VisualRenderQuality, VisualSynthHandle } from './VisualSynth';

const INPUT_GAIN_MIN = 0.2;
const INPUT_GAIN_MAX = 20;
const GATE_THRESHOLD_MIN = 0.005;
const GATE_THRESHOLD_MAX = 0.95;
const GATE_THRESHOLD_STEP = 0.005;
const LAYER_STORAGE_KEY = 'guitar-art.visualLayers.v1';
const PRESET_STORAGE_KEY = 'guitar-art.visualLayerPresets.v1';
const CONFIG_STORAGE_KEY = 'guitar-art.startConfig.v1';
const CALIBRATION_STORAGE_KEY = 'guitar-art.calibrated.v1';
const VISUAL_QUALITY_STORAGE_KEY = 'guitar-art.visualRenderQuality.v1';
const A4_HZ = 440;
const A4_MIDI = 69;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const MODE_LABELS: Record<VisualLayerMode, string> = {
  trails2d: '2D Trails',
  lineArt2d: '2D Line Art',
  fretPulse2d: '2D Fret Pulse',
  techniqueMap2d: '2D Technique Map',
  forms3d: '3D Forms',
  spectralField3d: '3D Spectral Field',
  chromaConstellation3d: '3D Chroma Constellation',
  guitarGlyph3d: '3D Guitar Glyph',
  stringResonator3d: '3D String Resonator',
  techniqueShard3d: '3D Technique Shards'
};

const MODE_KIND: Record<VisualLayerMode, VisualLayerKind> = {
  trails2d: '2d',
  lineArt2d: '2d',
  fretPulse2d: '2d',
  techniqueMap2d: '2d',
  forms3d: '3d',
  spectralField3d: '3d',
  chromaConstellation3d: '3d',
  guitarGlyph3d: '3d',
  stringResonator3d: '3d',
  techniqueShard3d: '3d'
};

const CONTROL_TOOLTIPS: Record<string, string> = {
  inputSource:
    'Selects the upstream audio feature source. Live mode requests the native/CoreAudio input path and feeds the visual engine with measured DSP features from the selected interface channel. Simulator mode uses the renderer fallback feature stream. Visual effect: changes whether the art reacts to the guitar input or to synthetic motion, but it does not directly change a layer shader or drawing formula.',
  usbInput:
    'Chooses the physical audio device used before feature extraction. The selected device supplies the samples that become rms, peak, low, mid, high, spectralCentroid, pitch, chroma, guitar technique, voicing, and event features. Visual effect: different inputs can change every downstream visual because the entire DSP feature frame comes from this source.',
  channel:
    'Chooses which device channel is analyzed by the native audio engine. A fixed input index analyzes that channel only; Auto loudest lets the input picker favor the channel with the strongest signal. Visual effect: determines which guitar signal drives the feature frame, so a quiet or wrong channel will reduce gate activity, pitch confidence, chroma, events, and all layer motion.',
  buffer:
    'Sets the native input buffer size before DSP analysis. Smaller buffers lower monitoring and visual latency, while larger buffers are more tolerant of CPU spikes. Visual effect: this does not change the feature math directly, but it changes how quickly rms, onset, spectral flux, pitch, and guitar events arrive at the renderer.',
  inputGain:
    'Applies pre-analysis gain to the incoming audio stream. The native engine scales the signal before computing rms, peak, band energies, spectral features, pitch confidence, gate state, clipping, guitar events, and technique estimates. Visual effect: higher gain makes layers react sooner and more strongly, but too much gain can clip and overdrive onset, brightness, and event strength.',
  gateThreshold:
    'Sets the global input gate threshold used by the audio engine and the sidebar meter. It is compared against signal level before the app reports the gate state. Visual effect: a higher threshold keeps idle noise from opening the global gate, while a lower threshold allows quieter notes and string noise to keep the visuals active.',
  inputCalibration:
    'Samples quiet-room rms and peak values, then recommends gateThreshold and inputGain. The recommendation uses the observed noise floor and peak headroom before the native DSP features are scaled. Visual effect: calibration makes the visual response start above room noise while preserving enough headroom for attacks, bends, and strums.',
  live2dQuality:
    'Sets the internal canvas resolution limit for 2D layers before drawing. It does not change audio DSP features; it changes the pixel workload used by Trails, Line Art, Fret Pulse, and Technique Map layers. Visual effect: lower quality is faster and softer, while high quality preserves sharper line detail, pulses, and trails.',
  captureWidth:
    'Sets the exported still/video frame width. No DSP parameters are changed; the renderer composites the current 2D canvases and WebGL canvas into this capture size. Visual effect: wider captures preserve more horizontal detail and reduce scaling artifacts in exported media.',
  captureHeight:
    'Sets the exported still/video frame height. No DSP parameters are changed; the renderer composites the current visual frame at this output height. Visual effect: taller captures preserve vertical detail in fretboards, spectra, strings, and particle fields.',
  transparentBackground:
    'Controls whether captures clear to alpha or to the app background color. No DSP parameters are changed. Visual effect: transparent exports preserve only emitted layer pixels and are useful for compositing; opaque exports include the dark stage behind the art.',
  accumulationAlpha:
    'Sets the blend amount used by cumulative PNG recording. No DSP features are changed; each rendered frame is blended with globalCompositeOperation lighten/lighter using this alpha. Visual effect: lower values create long, subtle exposure trails; higher values make recent strokes, pulses, and particles dominate the accumulated image.',
  presets:
    'Stores and restores the current VisualLayer list and each layer control value. No DSP analysis is changed. Visual effect: recalls full visual response recipes, including which modes are active, their gate behavior, sensitivity, smoothing, opacity, and mode-specific control values.',
  layerMode:
    'Chooses the renderer for this layer. The mode determines which DSP features matter most: 2D modes draw from band energy, onset, pitch, voicing, technique, chroma, and events; 3D modes use those same features to move meshes, particles, strings, and point fields. Visual effect: swaps the entire visual vocabulary for this layer.',
  layerEnabled:
    'Toggles whether the layer participates in rendering. The DSP feature stream still exists, but this layer stops consuming it when disabled. Visual effect: hides or restores the layer without changing its saved controls.',
  sensitivity:
    'Multiplies incoming DSP features for this layer inside getLayerFrame: rms, peak, low, mid, high, spectralFlux, brightness, noisiness, attack, vibratoDepth, vibratoRate, and onset are scaled by sensitivity and gateMultiplier; spectralCentroid is scaled by 0.6 + sensitivity * 0.4. Visual effect: raises or lowers how strongly this layer responds to the same guitar performance.',
  smoothing:
    'Sets the one-pole smoothing amount for this layer frame. Each smoothed feature moves toward the target by 1 - smoothing, including rms, peak, low, mid, high, spectralCentroid, spectralFlux, brightness, noisiness, attack, vibratoDepth, vibratoRate, onset, noteStability, and hue. Visual effect: low values feel immediate and twitchy; high values create slower, more fluid visual inertia.',
  layerGateThreshold:
    'Sets this layer-specific gate threshold. The renderer compares raw features.rms against this value to compute gateOpen and gateMultiplier before scaling the layer frame. Visual effect: a higher layer gate makes the layer wait for stronger playing; a lower gate lets noise, sustain, and quiet notes continue to animate it.',
  opacity:
    'Sets the layer alpha after DSP response has been calculated. 2D layers assign canvas opacity; 3D layers apply it to materials, particles, lines, and points. Visual effect: fades the layer in the composite without reducing the underlying feature response.',
  requiresGate:
    'Controls how hard this layer is muted below its layer gate. When enabled, gateMultiplier becomes 0 while features.rms is below gateThreshold; when disabled, the layer keeps a low idle multiplier of 0.18. Visual effect: enabled creates clean silence between notes; disabled allows ambient drift and residual motion.',
  trailFade:
    '2D Trails. Uses frame.gateOpen and frame.rms to calculate the background fade alpha from this base value. When the gate is open, rms reduces the fade slightly; when closed, the fade is multiplied upward. Visual effect: lower values leave longer light trails, while higher values clear old strokes faster.',
  brushSize:
    '2D Trails. Feeds scaleAmount, which increases the trail radius with frame.low and frame.rms. Visual effect: higher values make broader orbiting brush arcs and larger low-frequency blooms around the moving trail center.',
  trailSpeed:
    '2D Trails. Feeds motionAmount, which multiplies the angular sweep and the trail center drift driven by frame.mid and frame.high. Visual effect: higher values make the trail head travel faster and produce more restless spiral motion.',
  bloom:
    '2D Trails. Feeds colorAmount, which offsets hue across each stroke phase while frame.high and frame.rms set saturation/lightness and alpha. Visual effect: higher values spread more color separation through the trailing arcs.',
  lineComplexity:
    '2D Line Art. Sets complexity and feeds scaleAmount. The renderer uses frame.mid * 7 * complexity for ring count, frame.high * 10 * complexity for point count, and frame.low * scaleAmount for base radius. Visual effect: higher values add more polygon/ring detail and increase the low-frequency expansion of the drawing.',
  lineWeight:
    '2D Line Art. Multiplies stroke width after frame.rms and ring index set the base line width. Visual effect: higher values thicken every generated contour without changing its DSP-driven geometry.',
  lineDrift:
    '2D Line Art. Feeds motionAmount. The renderer multiplies center drift and ring phase by motionAmount while frame.high, spectralCentroid, mid, low, onset, and noteStability shape the line geometry. Visual effect: higher values make the drawing orbit and rotate more aggressively around the canvas.',
  symmetry:
    '2D Line Art. Feeds colorAmount and directly adds points to each closed contour. It also increases hue stepping per ring through colorAmount. Visual effect: higher values create more radial sides and stronger color separation, so the drawing feels more mandala-like.',
  fretSpan2d:
    '2D Fret Pulse. Sets the displayed fret count used to map features.fretNumber, voicing candidate fretNumber, and guitar event fretNumber onto x positions. Visual effect: lower values zoom into the low frets; higher values show more of the neck and compress pulse spacing.',
  stringWarp:
    '2D Fret Pulse. Feeds motionAmount. Each string wobble uses stringEnergy, frame.vibratoDepth, current time, and motionAmount. Visual effect: higher values make strings bend and shimmer more with plucks, vibrato, and active string energy.',
  pulseDecay:
    '2D Fret Pulse. Feeds colorAmount and directly scales event ring radius. Guitar events expand for 1.3 seconds from event.t using event.strength, frame.onset, and this value. Visual effect: higher values make note, pluck, strum, bend, mute, and noise pulses travel farther before disappearing.',
  markerSize:
    '2D Fret Pulse. Feeds scaleAmount and directly scales voicing markers. Candidate confidence and frame.attack set the marker radius before this multiplier is applied. Visual effect: higher values make detected note locations larger and more radiant on the fret grid.',
  scrollSpeed:
    '2D Technique Map. Feeds motionAmount. The previous canvas is shifted left by 2 + motionAmount * 3 pixels each frame, and event x positions age leftward by age * width * 0.44 * motionAmount. Visual effect: higher values scroll the technique history faster and stretch event timing across the lane display.',
  laneGain:
    '2D Technique Map. Feeds scaleAmount and scales lane bar height. The lanes are driven by pickNoise, muteAmount, harmonicRatio, vibratoDepth, abs(bendCents) / 180, and chordConfidence. Visual effect: higher values make subtle technique signals more visible as taller lane columns.',
  historyFade:
    '2D Technique Map. Sets the background fade alpha drawn over the scrolling history. The DSP lanes and events are unchanged, but older pixels are erased at this rate. Visual effect: lower values preserve longer technique history; higher values make the map clear quickly.',
  eventAccent:
    '2D Technique Map. Feeds colorAmount and multiplies event alpha. Recent guitarEvents are mapped by type into lanes, with strength and age determining visibility. Visual effect: higher values make plucks, strums, bends, mutes, chord changes, and noise marks brighter and more forceful.',
  formScale:
    '3D Forms. Feeds scaleAmount. Mesh scale uses frame.rms * scaleAmount plus frame.low, while the geometry switches by pitch class when pitchConfidence and noteStability are high. Visual effect: higher values make the form breathe larger with loudness and low-frequency energy.',
  morphRate:
    '3D Forms. Stored as a mode control for this form layer. The current renderer changes geometry from pitch class, pitchConfidence, and noteStability, while rotation comes from spin/motionAmount. Visual effect: reserved for future morph timing; in the current renderer it has little direct visual impact.',
  spinForms:
    '3D Forms. Feeds motionAmount. Mesh rotation uses frame.mid, frame.high, noteStability, and this multiplier on all axes. Visual effect: higher values rotate the 3D form faster and make high/mid energy feel more kinetic.',
  particleBurst:
    '3D Forms. Feeds colorAmount and directly scales particle spawning on frame.onset. Particles inherit hue, rms, attack, and layer opacity. Visual effect: higher values create denser note-attack bursts around the morphing form.',
  fieldSpread:
    '3D Spectral Field. Feeds scaleAmount. Each point is assigned a low/mid/high band, and its radius uses band energy * scaleAmount plus frame.onset. Visual effect: higher values push the point cloud outward with stronger low, mid, and high energy.',
  orbitSpeedSpectral:
    '3D Spectral Field. Feeds motionAmount. Group rotation and each seeded point angle advance with motionAmount; frame.high and spectralCentroid add extra movement and depth. Visual effect: higher values make the spectral particles orbit faster and feel more turbulent.',
  pointSize:
    '3D Spectral Field. Feeds colorAmount and directly multiplies PointsMaterial size. Band energy and hue still drive point color. Visual effect: higher values make each spectral particle larger and brighter in the field.',
  density:
    '3D Spectral Field. Controls how many seeded points are active by multiplying the total seed count. Hidden points are moved offscreen. Visual effect: lower values create a sparse constellation; higher values fill out the full spectral cloud.',
  nodeScale:
    '3D Chroma Constellation. Feeds scaleAmount and scales each chroma node radius using features.chroma[pitchClass]. Visual effect: higher values spread active pitch classes farther around the circle and make harmonic motion more spacious.',
  chordTension:
    '3D Chroma Constellation. Feeds colorAmount and adds extra radius to pitch classes that belong to the detected chord. Chord membership comes from chordRoot, chordQuality, and chordConfidence. Visual effect: higher values pull chord tones outward and make the detected harmony feel more tense and geometric.',
  orbitChroma:
    '3D Chroma Constellation. Feeds motionAmount and directly controls rotation around z using frame.vibratoRate and abs(bendCents). Visual effect: higher values make the pitch-class constellation orbit faster, especially during vibrato and bends.',
  particleBloom:
    '3D Chroma Constellation. Stored as a mode control for this layer. Current particle spawning is driven by frame.attack, frame.onset, chroma values, and layer opacity. Visual effect: reserved for future particle intensity; in the current renderer it has little direct visual impact.',
  fretboardTilt:
    '3D Guitar Glyph. Feeds motionAmount and directly sets the fretboard x rotation. A secondary y rotation is driven by bendCents and motionAmount. Visual effect: higher positive values tilt the fretboard farther back, while negative values tip it forward.',
  fretSpanGlyph:
    '3D Guitar Glyph. Sets the fret count used to construct fret bars and map voicing candidate fretNumber to x positions. Visual effect: lower values zoom into the first frets; higher values show a longer compressed fretboard.',
  noteGlow:
    '3D Guitar Glyph. Feeds colorAmount and directly multiplies note-node emissive color and emissiveIntensity. The source signals are voicing candidate confidence, frame.attack, event strength, pitch class, and brightness. Visual effect: higher values make detected notes glow harder and flare more on attacks.',
  spectrumHeight:
    '3D Guitar Glyph. Feeds scaleAmount and directly scales the 36-bin logSpectrum bar heights under the fretboard. Visual effect: higher values make frequency content taller and easier to read beneath the string/note display.',
  stringCount:
    '3D String Resonator. Selects how many of the six modeled strings remain visible; hidden strings are moved offscreen. The visible strings still use voicing, stringNumber, pitchConfidence, guitarEvents, vibratoDepth, bendCents, pickNoise, muteAmount, and harmonicRatio. Visual effect: lower values isolate fewer strings; higher values show the full resonating instrument.',
  resonanceDecay:
    '3D String Resonator. Feeds motionAmount and directly controls how quickly per-string event energy decays. The decay also reacts to muteAmount, so palm muting damps strings faster. Visual effect: higher values let pluck energy ring longer; lower values produce tight, quickly damped waves.',
  waveDepth:
    '3D String Resonator. Feeds scaleAmount and directly multiplies wave amplitude from string energy, vibratoDepth, bendCents, and mute damping. Visual effect: higher values create deeper string displacement and more visible vibration.',
  bendSensitivity:
    '3D String Resonator. Feeds colorAmount and directly scales abs(bendCents) / 180 before it contributes to wave amplitude and group rotation. Visual effect: higher values make pitch bends visibly pull the string waves harder.',
  shardCount:
    '3D Technique Shards. Controls how many shard instances remain active by multiplying the seeded shard count. Visual effect: lower values create fewer fragments; higher values fills the full shard field.',
  scatter:
    '3D Technique Shards. Feeds colorAmount and directly multiplies shard radius. Radius is also driven by harmonicRatio and frame.mid. Visual effect: higher values spreads fragments farther from the center and makes technique energy feel more explosive.',
  spinShard:
    '3D Technique Shards. Feeds motionAmount. Group rotation and per-shard spin use techniqueIntensity, bend amount, pickNoise, and this multiplier. Visual effect: higher values make the shard field rotate and corkscrew faster.',
  fracture:
    '3D Technique Shards. Feeds scaleAmount and directly scales shard length from frame.rms, techniqueIntensity, and frame.attack. Visual effect: higher values makes each shard longer and more fractured during strong attacks or confident technique detection.'
};

type TunerReading = {
  active: boolean;
  noteName: string;
  cents: number;
  targetHz: number;
  pitchHz: number | null;
};

type CaptureSettings = {
  width: number;
  height: number;
  transparentBackground: boolean;
  accumulationAlpha: number;
};

type CalibrationState = {
  open: boolean;
  running: boolean;
  sampled: boolean;
  startedAt: number;
  progress: number;
  noiseFloor: number;
  recommendedGate: number;
  recommendedGain: number;
  clipping: boolean;
  message: string;
};

const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  width: 1920,
  height: 1080,
  transparentBackground: false,
  accumulationAlpha: 0.16
};

const DEFAULT_CALIBRATION: CalibrationState = {
  open: !localStorage.getItem(CALIBRATION_STORAGE_KEY),
  running: false,
  sampled: false,
  startedAt: 0,
  progress: 0,
  noiseFloor: 0,
  recommendedGate: DEFAULT_START_CONFIG.gateThreshold,
  recommendedGain: DEFAULT_START_CONFIG.inputGain,
  clipping: false,
  message: 'Select your interface channel, stay quiet, then sample the room.'
};

export function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [config, setConfig] = useState<AudioStartConfig>(loadConfig);
  const [layers, setLayers] = useState<VisualLayer[]>(loadLayers);
  const [presets, setPresets] = useState<VisualLayerPreset[]>(loadPresets);
  const [captureSettings, setCaptureSettings] = useState<CaptureSettings>(DEFAULT_CAPTURE_SETTINGS);
  const [calibration, setCalibration] = useState<CalibrationState>(DEFAULT_CALIBRATION);
  const [presetName, setPresetName] = useState('New preset');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [recording, setRecording] = useState(false);
  const [videoRecording, setVideoRecording] = useState(false);
  const [visualFullscreen, setVisualFullscreen] = useState(false);
  const [visualQuality, setVisualQuality] = useState<VisualRenderQuality>(loadVisualQuality);
  const [recordingStatus, setRecordingStatus] = useState('Ready to record');
  const [status, setStatus] = useState<AudioStatus>({
    running: false,
    mode: 'simulator',
    nativeAvailable: false,
    message: 'Starting.'
  });
  const { latest, latestRef } = useAudioFeatures();
  const visualSynthRef = useRef<VisualSynthHandle | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const audio = useMemo(() => getAudioClient(), []);
  const art = useMemo(() => getArtClient(), []);

  useEffect(() => {
    audio.listDevices().then(setDevices).catch(() => setDevices([]));
    const off = audio.onStatus(setStatus);
    audio.start(config).catch((error) => {
      setStatus((prev) => ({ ...prev, message: error instanceof Error ? error.message : 'Unable to start audio.' }));
    });
    return () => {
      off();
    };
  }, [audio]);

  useEffect(() => {
    localStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify(layers));
  }, [layers]);

  useEffect(() => {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
  }, [presets]);

  useEffect(() => {
    localStorage.setItem(VISUAL_QUALITY_STORAGE_KEY, visualQuality);
  }, [visualQuality]);

  useEffect(() => {
    if (!calibration.running) {
      return;
    }

    const samples: number[] = [];
    const peaks: number[] = [];
    const startedAt = performance.now();
    const durationMs = 2600;
    const timer = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const features = latestRef.current;
      samples.push(features.rms);
      peaks.push(features.peak);
      const progress = Math.min(1, elapsed / durationMs);
      if (progress < 1) {
        setCalibration((prev) => ({ ...prev, progress, noiseFloor: percentile(samples, 0.7), clipping: prev.clipping || features.clipping || features.peak > 0.92 }));
        return;
      }

      const noiseFloor = percentile(samples, 0.7);
      const peak = Math.max(...peaks, 0.001);
      const recommendedGate = Math.max(GATE_THRESHOLD_MIN, Math.min(0.22, noiseFloor * 3.4 + 0.006));
      const recommendedGain = Math.max(INPUT_GAIN_MIN, Math.min(INPUT_GAIN_MAX, config.inputGain * (0.42 / peak)));
      const clipping = peaks.some((value) => value > 0.92);
      setCalibration((prev) => ({
        ...prev,
        running: false,
        sampled: true,
        progress: 1,
        noiseFloor,
        recommendedGate,
        recommendedGain,
        clipping,
        message: clipping
          ? 'Input is clipping. Lower the interface gain, then sample again.'
          : 'Room profile ready. Apply the gate and gain when the meter looks stable.'
      }));
      window.clearInterval(timer);
    }, 100);

    return () => window.clearInterval(timer);
  }, [calibration.running, latestRef]);

  useEffect(() => {
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !visualFullscreen) {
        return;
      }
      setVisualFullscreen(false);
    };

    window.addEventListener('keydown', exitOnEscape);
    return () => {
      window.removeEventListener('keydown', exitOnEscape);
    };
  }, [visualFullscreen]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === config.deviceId),
    [devices, config.deviceId]
  );
  const channelCount = selectedDevice?.inputChannels ?? 2;

  async function start(mode: AudioMode = config.mode) {
    const next = { ...config, mode };
    setConfig(next);
    try {
      await audio.start(next);
    } catch (error) {
      setStatus((prev) => ({ ...prev, running: false, message: error instanceof Error ? error.message : 'Unable to start audio.' }));
    }
  }

  async function stop() {
    await audio.stop();
  }

  function updateStartConfig(update: Partial<AudioStartConfig>, restart = false) {
    setConfig((prev) => {
      const next = { ...prev, ...update };
      if (restart || status.running) {
        void audio.start(next).catch((error) => {
          setStatus((current) => ({ ...current, running: false, message: error instanceof Error ? error.message : 'Unable to restart audio.' }));
        });
      }
      return next;
    });
  }

  function updateInputGain(inputGain: number) {
    setConfig((prev) => ({ ...prev, inputGain }));
    void audio.setParams({ inputGain }).catch(() => undefined);
  }

  function updateGateThreshold(gateThreshold: number) {
    setConfig((prev) => ({ ...prev, gateThreshold }));
    void audio.setParams({ gateThreshold }).catch(() => undefined);
  }

  function addLayer(kind: VisualLayerKind) {
    const mode = kind === '2d' ? 'lineArt2d' : 'spectralField3d';
    setLayers((prev) => [...prev, createLayer(mode, prev.length)]);
  }

  function updateLayer(id: string, updater: (layer: VisualLayer) => VisualLayer) {
    setLayers((prev) => prev.map((layer) => (layer.id === id ? updater(layer) : layer)));
  }

  function updateLayerControl(id: string, key: keyof VisualLayerControls, value: number | boolean) {
    updateLayer(id, (layer) => ({
      ...layer,
      controls: syncDerivedLayerControls(layer.mode, {
        ...layer.controls,
        [key]: value
      })
    }));
  }

  function moveLayer(id: string, direction: -1 | 1) {
    setLayers((prev) => {
      const index = prev.findIndex((layer) => layer.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const [layer] = next.splice(index, 1);
      next.splice(nextIndex, 0, layer);
      return next;
    });
  }

  function removeLayer(id: string) {
    setLayers((prev) => prev.filter((layer) => layer.id !== id));
  }

  function savePreset() {
    const name = presetName.trim() || `Preset ${presets.length + 1}`;
    const preset: VisualLayerPreset = {
      id: createId(),
      name,
      layers: cloneLayers(layers),
      createdAt: Date.now()
    };
    setPresets((prev) => [...prev, preset]);
    setSelectedPresetId(preset.id);
  }

  function loadPreset() {
    const preset = presets.find((item) => item.id === selectedPresetId);
    if (preset) {
      setLayers(cloneLayers(preset.layers));
      setPresetName(preset.name);
    }
  }

  function deletePreset() {
    setPresets((prev) => prev.filter((preset) => preset.id !== selectedPresetId));
    setSelectedPresetId('');
  }

  function getCaptureOptions(): VisualCaptureOptions {
    return {
      width: captureSettings.width,
      height: captureSettings.height,
      transparentBackground: captureSettings.transparentBackground,
      accumulationAlpha: captureSettings.accumulationAlpha
    };
  }

  async function captureStill() {
    const result = visualSynthRef.current?.captureStill(getCaptureOptions()) ?? null;
    if (!result) {
      setRecordingStatus('No frame available');
      return;
    }
    await exportPngResult(result, 'Snapshot exported');
  }

  function startArtRecording() {
    visualSynthRef.current?.startRecording(getCaptureOptions());
    setRecording(true);
    setRecordingStatus('Recording cumulative image');
  }

  async function stopArtRecording() {
    const result = visualSynthRef.current?.stopRecording() ?? null;
    setRecording(false);
    if (!result) {
      setRecordingStatus('No recorded frames');
      return;
    }

    setRecordingStatus(`Preparing ${result.width}x${result.height} PNG`);
    try {
      await exportPngResult(result, 'PNG exported');
    } catch {
      setRecordingStatus('Export failed');
    }
  }

  async function startVideoRecording() {
    try {
      await visualSynthRef.current?.startVideoRecording(getCaptureOptions());
      setVideoRecording(true);
      setRecordingStatus('Recording WebM performance');
    } catch {
      setRecordingStatus('Video recording unavailable');
    }
  }

  async function stopVideoRecording() {
    setVideoRecording(false);
    const result = await visualSynthRef.current?.stopVideoRecording();
    if (!result) {
      setRecordingStatus('No video frames');
      return;
    }
    try {
      const exportResult = await art.exportMedia({
        dataUrl: result.dataUrl,
        mimeType: result.mimeType,
        extension: result.extension,
        suggestedName: createVideoFileName(result.durationMs)
      });
      setRecordingStatus(exportResult.canceled ? 'Export canceled' : 'WebM exported');
    } catch {
      setRecordingStatus('Video export failed');
    }
  }

  async function exportPngResult(result: VisualRecordingResult, successMessage: string) {
    const exportResult = await art.exportMedia({
      dataUrl: result.dataUrl,
      mimeType: 'image/png',
      extension: 'png',
      suggestedName: createRecordingFileName(result)
    });
    setRecordingStatus(exportResult.canceled ? 'Export canceled' : successMessage);
  }

  function enterVisualFullscreen() {
    setVisualFullscreen(true);
  }

  async function startCalibration() {
    setCalibration((prev) => ({
      ...prev,
      open: true,
      running: true,
      sampled: false,
      startedAt: performance.now(),
      progress: 0,
      message: 'Sampling room noise. Keep the guitar muted.'
    }));
    if (config.mode !== 'live' || !status.running) {
      await start('live');
    }
  }

  function applyCalibration() {
    if (!calibration.sampled) {
      setCalibration((prev) => ({ ...prev, open: true, message: 'Sample the room before applying calibration.' }));
      return;
    }
    const next = {
      inputGain: calibration.recommendedGain,
      gateThreshold: calibration.recommendedGate
    };
    setConfig((prev) => ({ ...prev, ...next }));
    void audio.setParams(next).catch(() => undefined);
    localStorage.setItem(CALIBRATION_STORAGE_KEY, 'true');
    setCalibration((prev) => ({ ...prev, open: false, message: 'Calibration applied.' }));
  }

  function resetCalibration() {
    const next = {
      inputGain: DEFAULT_START_CONFIG.inputGain,
      gateThreshold: DEFAULT_START_CONFIG.gateThreshold
    };
    setConfig((prev) => ({ ...prev, ...next }));
    void audio.setParams(next).catch(() => undefined);
    localStorage.removeItem(CALIBRATION_STORAGE_KEY);
    setCalibration((prev) => ({
      ...prev,
      open: true,
      running: false,
      sampled: false,
      progress: 0,
      noiseFloor: 0,
      recommendedGate: DEFAULT_START_CONFIG.gateThreshold,
      recommendedGain: DEFAULT_START_CONFIG.inputGain,
      clipping: false,
      message: 'Calibration reset. Sample the room again when ready.'
    }));
  }

  return (
    <div className="app-shell">
      <aside className="control-rail">
        <TunerPanel features={latest} />

        <section className="control-group">
          <label>
            <ControlLabel tooltip={CONTROL_TOOLTIPS.inputSource}>Input source</ControlLabel>
          </label>
          <div className="segmented">
            <button className={config.mode === 'live' ? 'active' : ''} onClick={() => start('live')}>
              Live
            </button>
            <button className={config.mode === 'simulator' ? 'active' : ''} onClick={() => start('simulator')}>
              Simulator
            </button>
          </div>
        </section>

        <section className="control-group">
          <label>
            <ControlLabel tooltip={CONTROL_TOOLTIPS.usbInput}>USB input</ControlLabel>
          </label>
          <select
            value={config.deviceId ?? ''}
            onChange={(event) => updateStartConfig({ deviceId: event.target.value || undefined }, true)}
          >
            <option value="">Default input</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} ({device.inputChannels}ch)
              </option>
            ))}
          </select>
          <button className="secondary" onClick={() => audio.listDevices().then(setDevices)}>
            Refresh devices
          </button>
        </section>

        <section className="control-group two-column">
          <label>
            <ControlLabel tooltip={CONTROL_TOOLTIPS.channel}>Channel</ControlLabel>
          </label>
          <select
            value={config.channelIndex}
            onChange={(event) => updateStartConfig({ channelIndex: Number(event.target.value) }, true)}
          >
            {Array.from({ length: channelCount }, (_, index) => (
              <option key={index} value={index}>
                Input {index + 1}
              </option>
            ))}
            <option value={channelCount}>Auto loudest</option>
          </select>
          <label>
            <ControlLabel tooltip={CONTROL_TOOLTIPS.buffer}>Buffer</ControlLabel>
          </label>
          <select
            value={config.bufferSize}
            onChange={(event) =>
              updateStartConfig({ bufferSize: Number(event.target.value) as 128 | 256 | 512 }, true)
            }
          >
            <option value={128}>128</option>
            <option value={256}>256</option>
            <option value={512}>512</option>
          </select>
        </section>

        <section className="control-group">
          <label>
            <ControlLabel tooltip={CONTROL_TOOLTIPS.inputGain} value={`${formatGainDb(config.inputGain)} (${config.inputGain.toFixed(2)}x)`}>
              Input gain
            </ControlLabel>
          </label>
          <input
            type="range"
            min={INPUT_GAIN_MIN}
            max={INPUT_GAIN_MAX}
            step="0.05"
            value={config.inputGain}
            onInput={(event) => updateInputGain(Number(event.currentTarget.value))}
          />
          <label>
            <ControlLabel tooltip={CONTROL_TOOLTIPS.gateThreshold} value={`${Math.round(config.gateThreshold * 100)}% (${config.gateThreshold.toFixed(3)})`}>
              Gate
            </ControlLabel>
          </label>
          <input
            type="range"
            min={GATE_THRESHOLD_MIN}
            max={GATE_THRESHOLD_MAX}
            step={GATE_THRESHOLD_STEP}
            value={config.gateThreshold}
            onInput={(event) => updateGateThreshold(Number(event.currentTarget.value))}
          />
        </section>

        <section className="calibration-card">
          <div className="calibration-header">
            <label>
              <ControlLabel tooltip={CONTROL_TOOLTIPS.inputCalibration}>Input calibration</ControlLabel>
            </label>
            <button className="secondary" onClick={() => setCalibration((prev) => ({ ...prev, open: !prev.open }))}>
              {calibration.open ? 'Hide' : 'Open'}
            </button>
          </div>
          {calibration.open ? (
            <div className="calibration-body">
              <div className="calibration-meter">
                <div style={{ width: `${Math.min(100, latest.rms * 100)}%` }} />
                <span style={{ left: `${Math.min(100, config.gateThreshold * 100)}%` }} />
              </div>
              <div className="calibration-grid">
                <DiagnosticStat label="Noise" value={calibration.noiseFloor} />
                <DiagnosticStat label="Gate" value={calibration.recommendedGate} />
                <DiagnosticStat label="Target" valueText={`${calibration.recommendedGain.toFixed(2)}x`} />
                <DiagnosticStat label="Peak" value={latest.peak} />
              </div>
              <div className="channel-test">
                <button
                  className="secondary"
                  onClick={() => updateStartConfig({ channelIndex: Math.max(0, config.channelIndex - 1) }, true)}
                  disabled={config.channelIndex <= 0}
                >
                  Prev channel
                </button>
                <button
                  className="secondary"
                  onClick={() => updateStartConfig({ channelIndex: Math.min(channelCount, config.channelIndex + 1) }, true)}
                  disabled={config.channelIndex >= channelCount}
                >
                  Next channel
                </button>
              </div>
              <div className="calibration-actions">
                <button onClick={startCalibration} disabled={calibration.running}>
                  {calibration.running ? `${Math.round(calibration.progress * 100)}%` : 'Sample room'}
                </button>
                <button className="secondary" onClick={applyCalibration} disabled={calibration.running || !calibration.sampled}>
                  Apply
                </button>
                <button className="secondary" onClick={resetCalibration} disabled={calibration.running}>
                  Reset
                </button>
              </div>
              <div className={`record-state ${calibration.clipping ? 'warning' : ''}`}>{calibration.message}</div>
            </div>
          ) : null}
        </section>

        <section className="record-panel">
          <label>Art capture</label>
          <div className="control-group">
            <label>
              <ControlLabel tooltip={CONTROL_TOOLTIPS.live2dQuality}>Live 2D quality</ControlLabel>
            </label>
            <div className="segmented three">
              {(['low', 'medium', 'high'] as const).map((quality) => (
                <button
                  key={quality}
                  type="button"
                  className={visualQuality === quality ? 'active' : ''}
                  onClick={() => setVisualQuality(quality)}
                >
                  {quality[0].toUpperCase() + quality.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="capture-grid">
            <label>
              <ControlLabel tooltip={CONTROL_TOOLTIPS.captureWidth}>Width</ControlLabel>
              <input
                type="number"
                min={640}
                max={7680}
                step={160}
                value={captureSettings.width}
                onInput={(event) => setCaptureSettings((prev) => ({ ...prev, width: Number(event.currentTarget.value) }))}
              />
            </label>
            <label>
              <ControlLabel tooltip={CONTROL_TOOLTIPS.captureHeight}>Height</ControlLabel>
              <input
                type="number"
                min={360}
                max={4320}
                step={90}
                value={captureSettings.height}
                onInput={(event) => setCaptureSettings((prev) => ({ ...prev, height: Number(event.currentTarget.value) }))}
              />
            </label>
          </div>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={captureSettings.transparentBackground}
              onChange={(event) => setCaptureSettings((prev) => ({ ...prev, transparentBackground: event.target.checked }))}
            />
            <ControlLabel tooltip={CONTROL_TOOLTIPS.transparentBackground}>Transparent</ControlLabel>
          </label>
          <LayerSlider
            label="Accumulation"
            tooltip={CONTROL_TOOLTIPS.accumulationAlpha}
            value={captureSettings.accumulationAlpha}
            min={0.04}
            max={0.4}
            step={0.01}
            onChange={(value) => setCaptureSettings((prev) => ({ ...prev, accumulationAlpha: value }))}
          />
          <div className="record-actions">
            <button onClick={captureStill} disabled={recording || videoRecording}>
              Snapshot
            </button>
            <button onClick={startArtRecording} disabled={recording || videoRecording}>
              Cumulative
            </button>
            <button className="secondary" onClick={stopArtRecording} disabled={!recording}>
              Stop
            </button>
            <button onClick={startVideoRecording} disabled={recording || videoRecording}>
              WebM
            </button>
            <button className="secondary" onClick={stopVideoRecording} disabled={!videoRecording}>
              Stop video
            </button>
          </div>
          <div className={`record-state ${recording ? 'active' : ''}`}>{recordingStatus}</div>
        </section>

        <section className="transport">
          <button onClick={() => start(config.mode)}>{status.running ? 'Restart' : 'Start'}</button>
          <button className="secondary" onClick={stop}>
            Stop
          </button>
        </section>
        <div className="sidebar-bottom">
          <SidebarGainMeter value={latest.rms} gateThreshold={config.gateThreshold} />
          <div className={`gate-pill ${latest.gate ? 'open' : ''}`}>{latest.gate ? 'Gate open' : 'Idle'}</div>
        </div>
      </aside>

      <aside className="layer-rail">
        <section className="layer-toolbar">
          <div>
            <span className="rail-kicker">Layers</span>
            <strong>{layers.length} active slot{layers.length === 1 ? '' : 's'}</strong>
          </div>
        </section>

        <section className="preset-panel">
          <label>
            <ControlLabel tooltip={CONTROL_TOOLTIPS.presets}>Presets</ControlLabel>
          </label>
          <input value={presetName} onInput={(event) => setPresetName(event.currentTarget.value)} />
          <div className="preset-actions">
            <button onClick={savePreset}>Save</button>
            <button className="secondary" onClick={loadPreset} disabled={!selectedPresetId}>
              Load
            </button>
            <button className="secondary" onClick={deletePreset} disabled={!selectedPresetId}>
              Delete
            </button>
          </div>
          <select value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.target.value)}>
            <option value="">Select preset</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </section>

        <div className="layer-stack">
          {layers.map((layer, index) => (
            <LayerEditor
              key={layer.id}
              layer={layer}
              index={index}
              isFirst={index === 0}
              isLast={index === layers.length - 1}
              onUpdate={updateLayer}
              onUpdateControl={updateLayerControl}
              onMove={moveLayer}
              onRemove={removeLayer}
            />
          ))}
        </div>
        <div className="layer-add-footer">
          <div className="layer-add-row">
            <button onClick={() => addLayer('2d')}>+ 2D</button>
            <button onClick={() => addLayer('3d')}>+ 3D</button>
          </div>
        </div>
      </aside>

      <main ref={viewportRef} className={`viewport ${visualFullscreen ? 'visual-fullscreen' : ''}`}>
        <VisualSynth
          ref={visualSynthRef}
          featuresRef={latestRef}
          layers={layers}
          transparentBackground={captureSettings.transparentBackground}
          renderQuality={visualQuality}
        />
        {!visualFullscreen ? (
          <>
            <button className="fullscreen-button" type="button" onClick={enterVisualFullscreen}>
              Fullscreen
            </button>
            <DiagnosticsPanel features={latest} />
            <MeterStrip features={latest} />
          </>
        ) : null}
      </main>
    </div>
  );
}

function LayerEditor({
  layer,
  index,
  isFirst,
  isLast,
  onUpdate,
  onUpdateControl,
  onMove,
  onRemove
}: {
  layer: VisualLayer;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onUpdate: (id: string, updater: (layer: VisualLayer) => VisualLayer) => void;
  onUpdateControl: (id: string, key: keyof VisualLayerControls, value: number | boolean) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
}) {
  const modeOptions = Object.entries(MODE_LABELS).filter(([mode]) => MODE_KIND[mode as VisualLayerMode] === layer.kind);

  return (
    <section className={`layer-card ${layer.enabled ? '' : 'muted'}`}>
      <div className="layer-card-top">
        <div>
          <span>Layer {index + 1}</span>
          <input value={layer.name} onInput={(event) => onUpdate(layer.id, (prev) => ({ ...prev, name: event.currentTarget.value }))} />
        </div>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={layer.enabled}
            onChange={(event) => onUpdate(layer.id, (prev) => ({ ...prev, enabled: event.target.checked }))}
          />
          <ControlLabel tooltip={CONTROL_TOOLTIPS.layerEnabled}>On</ControlLabel>
        </label>
      </div>

      <div className="layer-controls">
        <label>
          <ControlLabel tooltip={CONTROL_TOOLTIPS.layerMode}>Mode</ControlLabel>
        </label>
        <select
          value={layer.mode}
          onChange={(event) =>
            onUpdate(layer.id, (prev) => ({
              ...prev,
              mode: event.target.value as VisualLayerMode,
              name: MODE_LABELS[event.target.value as VisualLayerMode],
              controls: createModeControls(event.target.value as VisualLayerMode, prev.controls)
            }))
          }
        >
          {modeOptions.map(([mode, label]) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <ModeSpecificControls layer={layer} onUpdateControl={onUpdateControl} />
      <LayerSlider label="Input drive" tooltip={CONTROL_TOOLTIPS.sensitivity} value={layer.controls.sensitivity} min={0.1} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'sensitivity', value)} />
      <LayerSlider label="Response" tooltip={CONTROL_TOOLTIPS.smoothing} value={layer.controls.smoothing} min={0} max={0.95} step={0.01} onChange={(value) => onUpdateControl(layer.id, 'smoothing', value)} />
      <LayerSlider label="Layer gate" tooltip={CONTROL_TOOLTIPS.layerGateThreshold} value={layer.controls.gateThreshold} min={0} max={0.5} step={0.005} onChange={(value) => onUpdateControl(layer.id, 'gateThreshold', value)} />
      <LayerSlider label="Opacity" tooltip={CONTROL_TOOLTIPS.opacity} value={layer.controls.opacity} min={0} max={1} step={0.01} onChange={(value) => onUpdateControl(layer.id, 'opacity', value)} />

      <label className="switch-row">
        <input
          type="checkbox"
          checked={layer.controls.requiresGate}
          onChange={(event) => onUpdateControl(layer.id, 'requiresGate', event.target.checked)}
        />
        <ControlLabel tooltip={CONTROL_TOOLTIPS.requiresGate}>Requires gate</ControlLabel>
      </label>

      <div className="layer-card-actions">
        <button className="secondary" onClick={() => onMove(layer.id, -1)} disabled={isFirst}>
          Up
        </button>
        <button className="secondary" onClick={() => onMove(layer.id, 1)} disabled={isLast}>
          Down
        </button>
        <button className="secondary" onClick={() => onRemove(layer.id)}>
          Remove
        </button>
      </div>
    </section>
  );
}

function ModeSpecificControls({
  layer,
  onUpdateControl
}: {
  layer: VisualLayer;
  onUpdateControl: (id: string, key: keyof VisualLayerControls, value: number | boolean) => void;
}) {
  const control = (key: keyof VisualLayerControls, fallback: number) =>
    typeof layer.controls[key] === 'number' ? (layer.controls[key] as number) : fallback;

  if (layer.mode === 'trails2d') {
    return (
      <>
        <LayerSlider label="Trail fade" tooltip={CONTROL_TOOLTIPS.trailFade} value={control('trailFade', 0.028)} min={0.006} max={0.08} step={0.001} onChange={(value) => onUpdateControl(layer.id, 'trailFade', value)} />
        <LayerSlider label="Brush size" tooltip={CONTROL_TOOLTIPS.brushSize} value={control('brushSize', 1)} min={0.25} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'brushSize', value)} />
        <LayerSlider label="Drift speed" tooltip={CONTROL_TOOLTIPS.trailSpeed} value={control('trailSpeed', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'trailSpeed', value)} />
        <LayerSlider label="Bloom" tooltip={CONTROL_TOOLTIPS.bloom} value={control('bloom', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'bloom', value)} />
      </>
    );
  }

  if (layer.mode === 'lineArt2d') {
    return (
      <>
        <LayerSlider label="Complexity" tooltip={CONTROL_TOOLTIPS.lineComplexity} value={control('lineComplexity', 1)} min={0.3} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'lineComplexity', value)} />
        <LayerSlider label="Line weight" tooltip={CONTROL_TOOLTIPS.lineWeight} value={control('lineWeight', 1)} min={0.25} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'lineWeight', value)} />
        <LayerSlider label="Drift" tooltip={CONTROL_TOOLTIPS.lineDrift} value={control('lineDrift', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'lineDrift', value)} />
        <LayerSlider label="Symmetry" tooltip={CONTROL_TOOLTIPS.symmetry} value={control('symmetry', 1)} min={0.5} max={4} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'symmetry', value)} />
      </>
    );
  }

  if (layer.mode === 'fretPulse2d') {
    return (
      <>
        <LayerSlider label="Fret span" tooltip={CONTROL_TOOLTIPS.fretSpan2d} value={control('fretSpan', 12)} min={5} max={24} step={1} onChange={(value) => onUpdateControl(layer.id, 'fretSpan', value)} />
        <LayerSlider label="String warp" tooltip={CONTROL_TOOLTIPS.stringWarp} value={control('stringWarp', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'stringWarp', value)} />
        <LayerSlider label="Pulse decay" tooltip={CONTROL_TOOLTIPS.pulseDecay} value={control('pulseDecay', 1)} min={0.25} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'pulseDecay', value)} />
        <LayerSlider label="Marker size" tooltip={CONTROL_TOOLTIPS.markerSize} value={control('markerSize', 1)} min={0.25} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'markerSize', value)} />
      </>
    );
  }

  if (layer.mode === 'techniqueMap2d') {
    return (
      <>
        <LayerSlider label="Scroll speed" tooltip={CONTROL_TOOLTIPS.scrollSpeed} value={control('scrollSpeed', 1)} min={0.2} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'scrollSpeed', value)} />
        <LayerSlider label="Lane gain" tooltip={CONTROL_TOOLTIPS.laneGain} value={control('laneGain', 1)} min={0.25} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'laneGain', value)} />
        <LayerSlider label="History fade" tooltip={CONTROL_TOOLTIPS.historyFade} value={control('historyFade', 0.035)} min={0.006} max={0.12} step={0.001} onChange={(value) => onUpdateControl(layer.id, 'historyFade', value)} />
        <LayerSlider label="Event accent" tooltip={CONTROL_TOOLTIPS.eventAccent} value={control('eventAccent', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'eventAccent', value)} />
      </>
    );
  }

  if (layer.mode === 'forms3d') {
    return (
      <>
        <LayerSlider label="Form scale" tooltip={CONTROL_TOOLTIPS.formScale} value={control('formScale', 1)} min={0.3} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'formScale', value)} />
        <LayerSlider label="Morph rate" tooltip={CONTROL_TOOLTIPS.morphRate} value={control('morphRate', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'morphRate', value)} />
        <LayerSlider label="Spin" tooltip={CONTROL_TOOLTIPS.spinForms} value={control('spin', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'spin', value)} />
        <LayerSlider label="Particle burst" tooltip={CONTROL_TOOLTIPS.particleBurst} value={control('particleBurst', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'particleBurst', value)} />
      </>
    );
  }

  if (layer.mode === 'spectralField3d') {
    return (
      <>
        <LayerSlider label="Field spread" tooltip={CONTROL_TOOLTIPS.fieldSpread} value={control('fieldSpread', 1)} min={0.3} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'fieldSpread', value)} />
        <LayerSlider label="Orbit speed" tooltip={CONTROL_TOOLTIPS.orbitSpeedSpectral} value={control('orbitSpeed', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'orbitSpeed', value)} />
        <LayerSlider label="Point size" tooltip={CONTROL_TOOLTIPS.pointSize} value={control('pointSize', 1)} min={0.25} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'pointSize', value)} />
        <LayerSlider label="Density" tooltip={CONTROL_TOOLTIPS.density} value={control('density', 1)} min={0.25} max={1} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'density', value)} />
      </>
    );
  }

  if (layer.mode === 'chromaConstellation3d') {
    return (
      <>
        <LayerSlider label="Node scale" tooltip={CONTROL_TOOLTIPS.nodeScale} value={control('nodeScale', 1)} min={0.3} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'nodeScale', value)} />
        <LayerSlider label="Chord tension" tooltip={CONTROL_TOOLTIPS.chordTension} value={control('chordTension', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'chordTension', value)} />
        <LayerSlider label="Orbit" tooltip={CONTROL_TOOLTIPS.orbitChroma} value={control('orbitSpeed', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'orbitSpeed', value)} />
        <LayerSlider label="Particle bloom" tooltip={CONTROL_TOOLTIPS.particleBloom} value={control('particleBloom', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'particleBloom', value)} />
      </>
    );
  }

  if (layer.mode === 'guitarGlyph3d') {
    return (
      <>
        <LayerSlider label="Fretboard tilt" tooltip={CONTROL_TOOLTIPS.fretboardTilt} value={control('fretboardTilt', 1)} min={-2} max={2} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'fretboardTilt', value)} />
        <LayerSlider label="Fret span" tooltip={CONTROL_TOOLTIPS.fretSpanGlyph} value={control('fretSpan', 12)} min={5} max={24} step={1} onChange={(value) => onUpdateControl(layer.id, 'fretSpan', value)} />
        <LayerSlider label="Note glow" tooltip={CONTROL_TOOLTIPS.noteGlow} value={control('noteGlow', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'noteGlow', value)} />
        <LayerSlider label="Spectrum height" tooltip={CONTROL_TOOLTIPS.spectrumHeight} value={control('spectrumHeight', 1)} min={0.2} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'spectrumHeight', value)} />
      </>
    );
  }

  if (layer.mode === 'stringResonator3d') {
    return (
      <>
        <LayerSlider label="Strings" tooltip={CONTROL_TOOLTIPS.stringCount} value={control('stringCount', 6)} min={1} max={6} step={1} onChange={(value) => onUpdateControl(layer.id, 'stringCount', value)} />
        <LayerSlider label="Decay" tooltip={CONTROL_TOOLTIPS.resonanceDecay} value={control('resonanceDecay', 1)} min={0.25} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'resonanceDecay', value)} />
        <LayerSlider label="Wave depth" tooltip={CONTROL_TOOLTIPS.waveDepth} value={control('waveDepth', 1)} min={0.1} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'waveDepth', value)} />
        <LayerSlider label="Bend sensitivity" tooltip={CONTROL_TOOLTIPS.bendSensitivity} value={control('bendSensitivity', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'bendSensitivity', value)} />
      </>
    );
  }

  return (
    <>
      <LayerSlider label="Shard count" tooltip={CONTROL_TOOLTIPS.shardCount} value={control('shardCount', 1)} min={0.2} max={1} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'shardCount', value)} />
      <LayerSlider label="Scatter" tooltip={CONTROL_TOOLTIPS.scatter} value={control('scatter', 1)} min={0.2} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'scatter', value)} />
      <LayerSlider label="Spin" tooltip={CONTROL_TOOLTIPS.spinShard} value={control('spin', 1)} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'spin', value)} />
      <LayerSlider label="Fracture" tooltip={CONTROL_TOOLTIPS.fracture} value={control('fracture', 1)} min={0.2} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'fracture', value)} />
    </>
  );
}

function LayerSlider({
  label,
  tooltip,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  tooltip?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="layer-slider">
      <label>
        <ControlLabel tooltip={tooltip} value={value.toFixed(step < 0.01 ? 3 : 2)}>
          {label}
        </ControlLabel>
      </label>
      <input type="range" min={min} max={max} step={step} value={value} onInput={(event) => onChange(Number(event.currentTarget.value))} />
    </div>
  );
}

function ControlLabel({ children, tooltip, value }: { children: ReactNode; tooltip?: string; value?: ReactNode }) {
  return (
    <span className={`control-label${tooltip ? ' has-tooltip' : ''}`} tabIndex={tooltip ? 0 : undefined}>
      <span className="control-label-row">
        <span className="control-label-name">{children}</span>
        {value !== undefined ? <span className="control-label-value">{value}</span> : null}
      </span>
      {tooltip ? (
        <span className="control-tooltip" role="tooltip">
          {tooltip}
        </span>
      ) : null}
    </span>
  );
}

function createLayer(mode: VisualLayerMode, index: number): VisualLayer {
  return {
    id: createId(),
    name: MODE_LABELS[mode],
    kind: MODE_KIND[mode],
    mode,
    enabled: true,
    controls: createModeControls(mode)
  };
}

function createModeControls(mode: VisualLayerMode, current: Partial<VisualLayerControls> = {}): VisualLayerControls {
  const base: VisualLayerControls = {
    ...DEFAULT_LAYER_CONTROLS,
    opacity: mode.endsWith('3d') ? 0.95 : 0.78,
    requiresGate: mode === 'forms3d' || mode === 'stringResonator3d' || mode === 'techniqueShard3d',
    ...current
  };
  const presets: Partial<Record<VisualLayerMode, Partial<VisualLayerControls>>> = {
    trails2d: { trailFade: 0.018, trailSpeed: 1.35, brushSize: 1.1, bloom: 1.25 },
    lineArt2d: { lineComplexity: 1.2, lineWeight: 1, lineDrift: 0.85, symmetry: 1.6 },
    fretPulse2d: { fretSpan: 12, stringWarp: 1.25, pulseDecay: 1.1, markerSize: 1.05, requiresGate: true },
    techniqueMap2d: { scrollSpeed: 1.1, laneGain: 1.15, historyFade: 0.035, eventAccent: 1.25 },
    forms3d: { formScale: 1.1, morphRate: 1.15, spin: 0.9, particleBurst: 1.2, requiresGate: true },
    spectralField3d: { fieldSpread: 1.15, orbitSpeed: 0.9, pointSize: 1, density: 1 },
    chromaConstellation3d: { nodeScale: 1.05, chordTension: 1.3, orbitSpeed: 0.8, particleBloom: 1.2 },
    guitarGlyph3d: { fretboardTilt: 1, fretSpan: 12, noteGlow: 1.25, spectrumHeight: 1.1 },
    stringResonator3d: { stringCount: 6, resonanceDecay: 1.1, waveDepth: 1.25, bendSensitivity: 1.2, requiresGate: true },
    techniqueShard3d: { shardCount: 1, scatter: 1.1, spin: 1.05, fracture: 1.2, requiresGate: true }
  };
  return syncDerivedLayerControls(mode, { ...base, ...(presets[mode] ?? {}), ...current });
}

function syncDerivedLayerControls(mode: VisualLayerMode, controls: VisualLayerControls): VisualLayerControls {
  const next = { ...controls };
  if (mode === 'trails2d') {
    next.motionAmount = Number(next.trailSpeed ?? 1);
    next.scaleAmount = Number(next.brushSize ?? 1);
    next.colorAmount = Number(next.bloom ?? 1);
  } else if (mode === 'lineArt2d') {
    next.motionAmount = Number(next.lineDrift ?? 1);
    next.scaleAmount = Number(next.lineComplexity ?? 1);
    next.colorAmount = Number(next.symmetry ?? 1);
  } else if (mode === 'fretPulse2d') {
    next.motionAmount = Number(next.stringWarp ?? 1);
    next.scaleAmount = Number(next.markerSize ?? 1);
    next.colorAmount = Number(next.pulseDecay ?? 1);
  } else if (mode === 'techniqueMap2d') {
    next.motionAmount = Number(next.scrollSpeed ?? 1);
    next.scaleAmount = Number(next.laneGain ?? 1);
    next.colorAmount = Number(next.eventAccent ?? 1);
  } else if (mode === 'forms3d') {
    next.motionAmount = Number(next.spin ?? 1);
    next.scaleAmount = Number(next.formScale ?? 1);
    next.colorAmount = Number(next.particleBurst ?? 1);
  } else if (mode === 'spectralField3d') {
    next.motionAmount = Number(next.orbitSpeed ?? 1);
    next.scaleAmount = Number(next.fieldSpread ?? 1);
    next.colorAmount = Number(next.pointSize ?? 1);
  } else if (mode === 'chromaConstellation3d') {
    next.motionAmount = Number(next.orbitSpeed ?? 1);
    next.scaleAmount = Number(next.nodeScale ?? 1);
    next.colorAmount = Number(next.chordTension ?? 1);
  } else if (mode === 'guitarGlyph3d') {
    next.motionAmount = Number(next.fretboardTilt ?? 1);
    next.scaleAmount = Number(next.spectrumHeight ?? 1);
    next.colorAmount = Number(next.noteGlow ?? 1);
  } else if (mode === 'stringResonator3d') {
    next.motionAmount = Number(next.resonanceDecay ?? 1);
    next.scaleAmount = Number(next.waveDepth ?? 1);
    next.colorAmount = Number(next.bendSensitivity ?? 1);
  } else {
    next.motionAmount = Number(next.spin ?? 1);
    next.scaleAmount = Number(next.fracture ?? 1);
    next.colorAmount = Number(next.scatter ?? 1);
  }
  return next;
}

function loadLayers(): VisualLayer[] {
  const stored = readJson<VisualLayer[]>(LAYER_STORAGE_KEY);
  if (!Array.isArray(stored)) {
    return cloneLayers(DEFAULT_VISUAL_LAYERS);
  }
  const layers = stored.map(normalizeLayer).filter(Boolean) as VisualLayer[];
  return layers.length > 0 ? layers : cloneLayers(DEFAULT_VISUAL_LAYERS);
}

function loadConfig(): AudioStartConfig {
  const stored = readJson<Partial<AudioStartConfig>>(CONFIG_STORAGE_KEY);
  if (!stored) {
    return DEFAULT_START_CONFIG;
  }
  return {
    ...DEFAULT_START_CONFIG,
    ...stored,
    mode: stored.mode === 'simulator' || stored.mode === 'live' ? stored.mode : DEFAULT_START_CONFIG.mode,
    channelIndex: typeof stored.channelIndex === 'number' ? Math.max(0, stored.channelIndex) : DEFAULT_START_CONFIG.channelIndex,
    bufferSize: stored.bufferSize === 128 || stored.bufferSize === 256 || stored.bufferSize === 512 ? stored.bufferSize : DEFAULT_START_CONFIG.bufferSize,
    sampleRate: 48000,
    inputGain: clampNumber(stored.inputGain, INPUT_GAIN_MIN, INPUT_GAIN_MAX, DEFAULT_START_CONFIG.inputGain),
    gateThreshold: clampNumber(stored.gateThreshold, GATE_THRESHOLD_MIN, GATE_THRESHOLD_MAX, DEFAULT_START_CONFIG.gateThreshold)
  };
}

function loadVisualQuality(): VisualRenderQuality {
  const stored = localStorage.getItem(VISUAL_QUALITY_STORAGE_KEY);
  return stored === 'low' || stored === 'medium' || stored === 'high' ? stored : 'medium';
}

function loadPresets(): VisualLayerPreset[] {
  const stored = readJson<VisualLayerPreset[]>(PRESET_STORAGE_KEY);
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored
    .map((preset) => ({
      id: typeof preset.id === 'string' ? preset.id : createId(),
      name: typeof preset.name === 'string' ? preset.name : 'Preset',
      layers: Array.isArray(preset.layers) ? (preset.layers.map(normalizeLayer).filter(Boolean) as VisualLayer[]) : [],
      createdAt: typeof preset.createdAt === 'number' ? preset.createdAt : Date.now()
    }))
    .filter((preset) => preset.layers.length > 0);
}

function normalizeLayer(layer: VisualLayer): VisualLayer | null {
  if (!layer || !MODE_KIND[layer.mode]) {
    return null;
  }
  const mode = layer.mode;
  return {
    id: typeof layer.id === 'string' ? layer.id : createId(),
    name: typeof layer.name === 'string' ? layer.name : MODE_LABELS[mode],
    kind: MODE_KIND[mode],
    mode,
    enabled: typeof layer.enabled === 'boolean' ? layer.enabled : true,
    controls: createModeControls(mode, layer.controls ?? {})
  };
}

function cloneLayers(layers: VisualLayer[]): VisualLayer[] {
  return layers.map((layer) => ({
    ...layer,
    controls: { ...layer.controls }
  }));
}

function readJson<T>(key: string): T | null {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `layer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createRecordingFileName(result: VisualRecordingResult): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `guitar-art-${stamp}-${result.frameCount}f.png`;
}

function createVideoFileName(durationMs: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `guitar-art-${stamp}-${Math.max(1, Math.round(durationMs / 1000))}s.webm`;
}

function percentile(values: number[], pct: number): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)))] ?? 0;
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function formatGainDb(gain: number): string {
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function TunerPanel({ features }: { features: ReturnType<typeof useAudioFeatures>['latest'] }) {
  const reading = getTunerReading(features.pitchHz, features.pitchConfidence);
  const clampedCents = Math.max(-50, Math.min(50, reading.cents));
  const needlePosition = 50 + clampedCents;
  const centsText = reading.active ? `${Math.abs(reading.cents).toFixed(1)} cents` : '-- cents';
  const direction = !reading.active ? 'waiting' : Math.abs(reading.cents) < 0.5 ? 'in tune' : reading.cents < 0 ? 'flat' : 'sharp';
  const centsClass = reading.active && Math.abs(reading.cents) <= 5 ? 'locked' : '';

  return (
    <section className={`tuner-panel ${reading.active ? 'active' : ''}`}>
      <div className="tuner-header">
        <span>Chromatic tuner</span>
        <strong>{reading.noteName}</strong>
      </div>
      <div className="tuner-meter" aria-label={`Tuner meter ${direction}`}>
        <div className="tuner-scale">
          <span>-50</span>
          <span>-25</span>
          <span>0</span>
          <span>+25</span>
          <span>+50</span>
        </div>
        <div className="tuner-track">
          <div className="tuner-center-line" />
          <div className="tuner-lock-zone" />
          <div className="tuner-needle" style={{ left: `${needlePosition}%` }} />
        </div>
      </div>
      <div className="tuner-readout">
        <span className={centsClass}>{centsText}</span>
        <span>{direction}</span>
      </div>
      <div className="tuner-detail">
        <span>{reading.active ? `${reading.pitchHz?.toFixed(2)} Hz` : 'Waiting for pitch'}</span>
        <span>{reading.active ? `Target ${reading.targetHz.toFixed(2)} Hz` : `A4 ${A4_HZ} Hz`}</span>
      </div>
    </section>
  );
}

function getTunerReading(pitchHz: number | null, confidence: number): TunerReading {
  if (!pitchHz || pitchHz <= 0 || confidence < 0.25) {
    return {
      active: false,
      noteName: '--',
      cents: 0,
      targetHz: A4_HZ,
      pitchHz: null
    };
  }

  const midiFloat = A4_MIDI + 12 * Math.log2(pitchHz / A4_HZ);
  const nearestMidi = Math.round(midiFloat);
  const cents = (midiFloat - nearestMidi) * 100;
  const targetHz = A4_HZ * 2 ** ((nearestMidi - A4_MIDI) / 12);

  return {
    active: true,
    noteName: midiToNoteName(nearestMidi),
    cents,
    targetHz,
    pitchHz
  };
}

function midiToNoteName(midi: number): string {
  const note = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

function SidebarGainMeter({ value, gateThreshold }: { value: number; gateThreshold: number }) {
  const meterValue = Math.max(0, Math.min(1, value));
  const gatePosition = Math.max(0, Math.min(1, gateThreshold));

  return (
    <div className="sidebar-meter">
      <div className="sidebar-meter-label">
        <span>Input</span>
        <strong>{Math.round(meterValue * 100)}</strong>
      </div>
      <div className="sidebar-meter-track">
        <div className="sidebar-meter-fill" style={{ width: `${Math.max(2, meterValue * 100)}%` }} />
        <div className="sidebar-meter-gate" style={{ left: `${gatePosition * 100}%` }} />
      </div>
    </div>
  );
}

function MeterStrip({ features }: { features: ReturnType<typeof useAudioFeatures>['latest'] }) {
  return (
    <div className="meter-strip">
      <Meter label="RMS" value={features.rms} />
      <Meter label="Peak" value={features.peak} alert={features.clipping} />
      <Meter label="Low" value={features.low} />
      <Meter label="Mid" value={features.mid} />
      <Meter label="High" value={features.high} />
      <Meter label="Centroid" value={features.spectralCentroid} />
      <Meter label="Pitch" value={features.pitchConfidence} note={features.noteName ?? '--'} />
      <Meter label="Stable" value={features.noteStability} />
      <Meter label="Onset" value={features.onset} pulse={features.onset > 0.3} />
    </div>
  );
}

function DiagnosticsPanel({ features }: { features: ReturnType<typeof useAudioFeatures>['latest'] }) {
  const chord = features.chordName ?? '--';
  const position = typeof features.stringNumber === 'number' && typeof features.fretNumber === 'number' ? `S${features.stringNumber} F${features.fretNumber}` : '--';
  const voicing = Array.isArray(features.voicing) ? features.voicing : [];
  const logSpectrum = Array.isArray(features.logSpectrum) ? features.logSpectrum : [];
  const technique = features.guitarTechnique ?? 'idle';
  const voicingConfidence = voicing.length
    ? voicing.reduce((sum, candidate) => sum + candidate.confidence, 0) / voicing.length
    : 0;
  return (
    <section className="diagnostics-panel">
      <div className="diagnostics-header">
        <span>{technique.replace('_', ' ')}</span>
        <strong>{chord}</strong>
      </div>
      <div className="chroma-bars" aria-label="Chroma energy">
        {NOTE_NAMES.map((note, index) => (
          <div className="chroma-bin" key={note}>
            <div style={{ height: `${Math.max(3, clampPercent(features.chroma[index] ?? 0))}%` }} />
            <span>{note}</span>
          </div>
        ))}
      </div>
      <div className="spectrum-bars" aria-label="Log spectrum">
        {logSpectrum.map((value, index) => (
          <div className="spectrum-bin" key={index} style={{ height: `${Math.max(4, clampPercent(value))}%` }} />
        ))}
      </div>
      <div className="diagnostic-grid">
        <DiagnosticStat label="Pos" valueText={position} />
        <DiagnosticStat label="Voice" value={voicingConfidence} />
        <DiagnosticStat label="Flux" value={features.spectralFlux} />
        <DiagnosticStat label="Pick" value={features.pickNoise} />
        <DiagnosticStat label="Mute" value={features.muteAmount} />
        <DiagnosticStat label="Harm" value={features.harmonicRatio} />
        <DiagnosticStat label="Bend" value={features.bendCents} suffix="c" signed />
        <DiagnosticStat label="Vib" value={features.vibratoDepth} />
      </div>
    </section>
  );
}

function DiagnosticStat({
  label,
  value,
  valueText,
  suffix = '',
  signed = false
}: {
  label: string;
  value?: number;
  valueText?: string;
  suffix?: string;
  signed?: boolean;
}) {
  const numericValue = value ?? 0;
  const text = valueText ?? (signed ? `${numericValue >= 0 ? '+' : ''}${numericValue.toFixed(0)}${suffix}` : `${Math.round(clampPercent(numericValue))}`);
  return (
    <div className="diagnostic-stat">
      <span>{label}</span>
      <strong>{text}</strong>
    </div>
  );
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value * 100));
}

function Meter({ label, value, note, alert, pulse }: { label: string; value: number; note?: string; alert?: boolean; pulse?: boolean }) {
  return (
    <div className={`meter ${alert ? 'alert' : ''} ${pulse ? 'pulse' : ''}`}>
      <div className="meter-label">
        <span>{label}</span>
        <strong>{note ?? Math.round(value * 100)}</strong>
      </div>
      <div className="meter-track">
        <div style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
      </div>
    </div>
  );
}

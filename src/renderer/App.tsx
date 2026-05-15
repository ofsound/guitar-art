import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  AudioDevice,
  AudioLibraryItem,
  AudioMode,
  AudioStartConfig,
  AudioStatus,
  MidiChannel,
  MidiMapping,
  MidiMappingRange,
  MidiMappingSource,
  MidiMappingTarget,
  VisualLayer,
  VisualLayerControls,
  VisualLayerKind,
  VisualLayerMode,
  VisualLayerPreset
} from '../shared/audio';
import { DEFAULT_LAYER_CONTROLS, DEFAULT_START_CONFIG, DEFAULT_VISUAL_LAYERS } from '../shared/audio';
import { getArtClient, getAudioClient, getLibraryClient, getPlaybackClient } from './audioClient';
import type { PlaybackTransportState } from './playbackFeatureEngine';
import type { ActivityAnalysisReport, ActivityMetricResult } from './audioAnalysis';
import { analyzeAudioRecording, createWaveformPreview } from './audioAnalysis';
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
const VISUAL_QUALITY_STORAGE_KEY = 'guitar-art.visualRenderQuality.v1';
const MIDI_LEARN_TIMEOUT_MS = 12_000;
const MIDI_SMOOTHING_AMOUNT = 0.35;
const A4_HZ = 440;
const A4_MIDI = 69;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const EMPTY_PLAYBACK_STATE: PlaybackTransportState = {
  itemId: null,
  itemName: null,
  loaded: false,
  playing: false,
  durationMs: 0,
  positionMs: 0,
  waveform: []
};

const MODE_LABELS: Record<VisualLayerMode, string> = {
  trails2d: '2D Trails',
  lineArt2d: '2D Line Art',
  fretPulse2d: '2D Fret Pulse',
  raindrops2d: '2D Raindrops',
  techniqueMap2d: '2D Technique Map',
  sideScroller2d: 'Side Scroller 2D',
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
  raindrops2d: '2d',
  techniqueMap2d: '2d',
  sideScroller2d: '2d',
  forms3d: '3d',
  spectralField3d: '3d',
  chromaConstellation3d: '3d',
  guitarGlyph3d: '3d',
  stringResonator3d: '3d',
  techniqueShard3d: '3d'
};

const CONTROL_TOOLTIPS: Record<string, string> = {
  inputSource:
    'Selects the upstream audio feature source. Live mode requests the native/CoreAudio input path, while Playback decodes an internal library file through Web Audio. Visual effect: changes whether the art reacts to live input or a saved audio file.',
  playbackLibrary:
    'Manages the internal Playback library. Imported MP3, WAV, AIFF, and AIF files are copied into app storage, while recorded input is saved as WAV. Visual effect: the selected library item becomes the audio feature stream when Playback is active.',
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
  sideScrollSpeed:
    'Side Scroller 2D. Feeds motionAmount. The layer shifts the existing piano-roll history left by a frame-scaled amount and writes the newest spectral/pitch slice at the right edge. Visual effect: higher values make time pass faster and compress musical history horizontally.',
  sidePitchGain:
    'Side Scroller 2D. Feeds scaleAmount. Current activity from rms, onset, spectral flux, attack, and pitch confidence uses this multiplier for note-head size, spectrum thickness, and harmonic-lane length. Visual effect: higher values make active notes and busy passages more substantial.',
  sideHistoryFade:
    'Side Scroller 2D. Sets the color-preserving opacity fade after the canvas scrolls left. Visual effect: lower values keep older piano-roll trails saturated and sharp for longer; higher values make older moments disappear faster.',
  sideEventAccent:
    'Side Scroller 2D. Feeds colorAmount and scales attack/event flashes, bend tails, voicing markers, and the right-edge playhead brightness. Visual effect: higher values emphasize note starts, strums, and detected guitar gestures.',
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

type DspMeterLabel =
  | 'RMS'
  | 'Peak'
  | 'Low'
  | 'Mid'
  | 'High'
  | 'Centroid'
  | 'Pitch Hz'
  | 'Pitch'
  | 'Stable'
  | 'Onset'
  | 'Gate'
  | 'Clip'
  | 'Chroma'
  | 'Pos'
  | 'Voice'
  | 'Flux'
  | 'Rolloff'
  | 'Flat'
  | 'Zero X'
  | 'Bright'
  | 'Noise'
  | 'Attack'
  | 'Decay'
  | 'Pick'
  | 'Mute'
  | 'Harm'
  | 'Bend'
  | 'Vib'
  | 'Vib Rate'
  | 'Harm Dens'
  | 'Chord Root'
  | 'Chord Qual'
  | 'Chord Name'
  | 'Chord Conf'
  | 'Spectrum'
  | 'Contrast'
  | 'Technique'
  | 'Tech Conf'
  | 'Voicing'
  | 'Events';

const DSP_METER_TOOLTIPS = {
  RMS: 'Root-mean-square level of the current audio buffer; a smoothed loudness estimate used for gates and overall visual energy.',
  Peak: 'Highest absolute sample level in the current buffer. Red indicates the signal is close to clipping.',
  Low: 'Normalized low-band energy, roughly the bass/body portion of the guitar signal.',
  Mid: 'Normalized mid-band energy, where much of the picked note body and fretboard character sits.',
  High: 'Normalized high-band energy from brightness, pick edge, string noise, and upper harmonics.',
  Centroid: 'Spectral center of mass, normalized from dark/low-frequency content toward bright/high-frequency content.',
  'Pitch Hz': 'Estimated fundamental frequency in hertz. The bar shows pitch confidence; the note shows the detected Hz value.',
  Pitch: 'Confidence that the engine has a stable fundamental pitch estimate. The note shows the nearest detected pitch name.',
  Stable: 'How consistently the detected pitch is holding over time; higher values mean less pitch drift or ambiguity.',
  Onset: 'Short attack detector from sudden level and spectral increases; spikes at note starts, plucks, and strums.',
  Gate: 'Whether RMS is above the global input gate threshold, opening or idling the live visual response.',
  Clip: 'Clipping flag from near-full-scale peaks. OK means the current buffer is below the clipping threshold.',
  Chroma: 'Strongest pitch-class energy across the 12-note chroma vector; the note shows how many pitch classes are active.',
  Pos: 'Inferred guitar string and fret position for the current pitch. The bar follows pitch confidence.',
  Voice: 'Average confidence across inferred voicing candidates, summarizing how plausible the detected fretboard shape is.',
  Flux: 'Positive frame-to-frame spectral change. Higher values mean the frequency balance is moving quickly.',
  Rolloff: 'High-frequency rolloff estimate, rising when more energy sits in the upper spectrum.',
  Flat: 'Spectral flatness estimate. Higher values indicate noisier, less tone-like frequency content.',
  'Zero X': 'Zero-crossing rate of the waveform, often higher for noisy, bright, or distorted signals.',
  Bright: 'Combined high-band and centroid brightness estimate used by layers for color, shine, and edge intensity.',
  Noise: 'Combined flatness and zero-crossing estimate for noisy or scratchy content.',
  Attack: 'Transient strength from rising RMS and spectral flux; emphasizes the front edge of picked notes and strums.',
  Decay: 'Falling-level strength after a note or gesture, useful for damping and release motion.',
  Pick: 'Pick-noise estimate from very high frequencies, spectral motion, and brightness.',
  Mute: 'Palm-mute or damping estimate from decay, flatness, high-frequency content, and reduced pitch stability.',
  Harm: 'Harmonic ratio estimate from tonal flatness and pitch confidence; higher means clearer pitched harmonic content.',
  Bend: 'Absolute pitch bend amount in cents relative to the stable pitch reference; the note shows signed cents.',
  Vib: 'Vibrato depth from recent pitch-bend range.',
  'Vib Rate': 'Vibrato speed estimate from recent bend direction changes.',
  'Harm Dens': 'Harmonic density from pitch confidence, harmonic ratio, and low/mid-band support.',
  'Chord Root': 'Detected chord root note. The bar shows chord confidence.',
  'Chord Qual': 'Detected chord quality such as major, minor, power, sus, or seventh. The bar shows chord confidence.',
  'Chord Name': 'Combined detected chord name. The bar shows chord confidence.',
  'Chord Conf': 'Confidence in the current chord estimate from chroma pattern matching and harmonic density.',
  Spectrum: 'Average level across the log-spaced spectrum bins shown below the chroma display.',
  Contrast: 'Difference between strongest and weakest spectral bands, highlighting sharply separated tonal balance.',
  Technique: 'Current guitar technique classification such as idle, single note, strum, palm mute, bend, or vibrato. The bar shows confidence.',
  'Tech Conf': 'Confidence in the current guitar technique estimate.',
  Voicing: 'Strongest inferred string/fret voicing candidate. The note shows how many candidate notes are present.',
  Events: 'Recent detected guitar events such as plucks, strums, bends, mutes, chord changes, and noise gestures.'
} satisfies Record<DspMeterLabel, string>;

type ModeRoadmap = {
  description: string;
  dspMappings: string[];
  controlMappings: string[];
  visualMappings: string[];
};

const SHARED_FRAME_ROADMAP = [
  'features.rms is compared with controls.gateThreshold to create frame.gateOpen.',
  'controls.requiresGate sets gateMultiplier to 0 when closed; otherwise closed layers keep a 0.18 idle multiplier.',
  'frame.rms, peak, low, mid, high, spectralFlux, brightness, noisiness, attack, vibratoDepth, and vibratoRate are clamp01(feature * controls.sensitivity * gateMultiplier).',
  'frame.onset is clamp01(max(features.onset, features.spectralFlux) * controls.sensitivity * gateMultiplier).',
  'frame.spectralCentroid is clamp01(features.spectralCentroid * (0.6 + controls.sensitivity * 0.4)).',
  'frame.noteStability passes through features.noteStability.',
  'frame.hue uses log2(features.pitchHz / 82.41) when features.pitchConfidence > 0.35, otherwise 0.08 + features.spectralCentroid * 0.52.',
  'controls.smoothing applies one-pole smoothing with amount = 1 - controls.smoothing to every frame value above and to hue.'
];

const MODE_ROADMAPS: Record<VisualLayerMode, ModeRoadmap> = {
  trails2d: {
    description: 'A fading 2D brush trail where level, band balance, onset, pitch color, and note stability bend one moving ribbon system.',
    dspMappings: [
      'frame.gateOpen and frame.rms set the background fade: open gates reduce controls.trailFade by rms * 42%; closed gates multiply fade by 1.65.',
      'frame.low and frame.rms set brush radius: 20 + frame.low * 280 * controls.scaleAmount + frame.rms * 160.',
      'frame.mid and frame.onset set stroke count: 4 + floor(frame.mid * 18 + frame.onset * 24).',
      'frame.high offsets the stroke angle and increases hue saturation.',
      'frame.noteStability compresses/expands the y orbit, while frame.spectralCentroid expands y travel.',
      'frame.mid and frame.high move the trail center through trailX/trailY drift.'
    ],
    controlMappings: [
      'controls.trailSpeed -> controls.motionAmount -> stroke angular speed and trail center drift.',
      'controls.brushSize -> controls.scaleAmount -> low/rms radius expansion.',
      'controls.bloom -> controls.colorAmount -> per-stroke hue offsets.',
      'controls.trailFade -> background erase alpha and trail persistence.'
    ],
    visualMappings: [
      'Louder low energy produces wider arcs.',
      'Mid energy and onsets add more simultaneous strokes.',
      'High energy sharpens hue/saturation and makes the trail feel quicker.',
      'Stable notes make the ribbon orbit more coherently around the center.'
    ]
  },
  lineArt2d: {
    description: 'A generative contour drawing where spectrum bands become rings, polygon points, radius, stroke weight, and color separation.',
    dspMappings: [
      'frame.gateOpen chooses the canvas fade alpha: 0.005 open and 0.012 closed.',
      'frame.mid sets ring count through 2 + floor(frame.mid * 7 * controls.lineComplexity).',
      'frame.high sets point count through 5 + floor(frame.high * 10 * controls.lineComplexity + controls.symmetry * 2).',
      'frame.low sets base radius with min(width, height) * (0.08 + frame.low * 0.24 * controls.scaleAmount).',
      'frame.onset adds 80px of radial expansion to each ring.',
      'frame.rms sets lightness, alpha, and line width; frame.spectralCentroid and frame.mid modulate contour wobble.',
      'frame.noteStability changes vertical contour scale, making stable notes more oval and sustained.'
    ],
    controlMappings: [
      'controls.lineComplexity -> ring count, point count, and controls.scaleAmount.',
      'controls.lineWeight -> final stroke width multiplier.',
      'controls.lineDrift -> controls.motionAmount -> center drift and ring phase speed.',
      'controls.symmetry -> point count and controls.colorAmount hue stepping.'
    ],
    visualMappings: [
      'Midrange energy adds nested contours.',
      'High-frequency energy increases angular detail.',
      'Onsets inflate rings outward.',
      'RMS makes lines brighter, thicker, and more opaque.'
    ]
  },
  fretPulse2d: {
    description: 'A 2D fretboard scope that maps detected strings, frets, voicing candidates, bends, and guitar events into pulsing note positions.',
    dspMappings: [
      'features.voicing[].fretNumber maps to x position across controls.fretSpan; features.voicing[].stringNumber maps to y string lanes.',
      'features.voicing[].confidence and frame.attack set marker radius, marker alpha, and marker stroke width.',
      'features.voicing[].pitchClass plus frame.hue sets marker color.',
      'getStringEnergy combines voicing confidence, active features.stringNumber with features.pitchConfidence, and recent features.guitarEvents[].strength.',
      'String line width uses stringEnergy and features.muteAmount.',
      'String wobble uses stringEnergy, frame.vibratoDepth, time, and controls.motionAmount.',
      'features.guitarEvents[].type, strength, t, fretNumber, and stringNumber create 1.3 second expanding pulse rings.',
      'features.bendCents draws a bend curve when abs(bendCents) > 8 and string/fret are known.'
    ],
    controlMappings: [
      'controls.fretSpan -> fret grid size and fret-to-x mapping.',
      'controls.stringWarp -> controls.motionAmount -> string wobble depth/speed.',
      'controls.pulseDecay -> controls.colorAmount -> guitar event pulse radius.',
      'controls.markerSize -> controls.scaleAmount -> voicing marker size.'
    ],
    visualMappings: [
      'Detected notes glow at their string/fret coordinates.',
      'Recent plucks, strums, bends, mutes, chord changes, and noise radiate rings.',
      'Palm muting thickens string lanes while damping resonance elsewhere.',
      'Bends become curved pitch gestures above or below the note.'
    ]
  },
  raindrops2d: {
    description: 'A minimal black-and-white 2D ripple field where each detected pluck creates a random expanding ring animation.',
    dspMappings: [
      'features.guitarEvents[] supplies pluck and note_on events.',
      'Each new event id is assigned one random x/y point on the canvas.',
      'event.strength and frame.rms are represented in the ring size, line weight, and fade.',
      'Event age expands the rings and fades them out over a short fixed lifetime.'
    ],
    controlMappings: [
      'controls.sensitivity affects event strength through the shared frame calculation.',
      'controls.opacity sets the whole layer opacity.',
      'No dedicated raindrop controls are exposed yet.'
    ],
    visualMappings: [
      'Each pluck becomes a distinct white ripple at a random point.',
      'Stronger attacks create larger and brighter rings.',
      'The layer intentionally ignores pitch, string, fret, and color.'
    ]
  },
  techniqueMap2d: {
    description: 'A scrolling 2D technique history where six guitar-expression lanes and recent events are written as time columns.',
    dspMappings: [
      'Lane 1 maps features.pickNoise to pick/noise height.',
      'Lane 2 maps features.muteAmount to mute height.',
      'Lane 3 maps features.harmonicRatio to harmonic content height.',
      'Lane 4 maps features.vibratoDepth to vibrato height.',
      'Lane 5 maps abs(features.bendCents) / 180 to bend height.',
      'Lane 6 maps features.chordConfidence to harmony confidence height.',
      'features.logSpectrum supplies moving lane strokes by sampled spectrum bin.',
      'features.guitarEvents[].type maps to lanes with eventLaneIndex; event strength and age set line alpha and width.',
      'features.chroma[pitchClass] draws pitch-class strips for bins above 0.16.'
    ],
    controlMappings: [
      'controls.scrollSpeed -> controls.motionAmount -> canvas shift and event age-to-x speed.',
      'controls.laneGain -> controls.scaleAmount -> lane bar height multiplier.',
      'controls.historyFade -> color-preserving history opacity fade.',
      'controls.eventAccent -> controls.colorAmount -> guitar event alpha multiplier.'
    ],
    visualMappings: [
      'The newest technique data enters on the right and ages leftward.',
      'Each horizontal lane isolates one guitar behavior.',
      'Events appear as brighter vertical strikes in the lane for their event type.',
      'Chroma adds thin pitch-class traces near the bottom of the map.'
    ]
  },
  sideScroller2d: {
    description: 'A piano-roll side scroller where the newest musical moment is written on the right edge and fades left as pitch, spectrum, and activity history.',
    dspMappings: [
      'The existing canvas shifts left every frame by frame-scaled controls.motionAmount, so time enters on the right and ages leftward.',
      'features.pitchHz maps to y with a guitar-centered MIDI range; higher pitch produces a taller screen position.',
      'Pitch confidence, frame.rms, frame.onset, frame.spectralFlux, and frame.attack combine into activity, which sets note-head size, alpha, line width, and spectrum column thickness.',
      'features.logSpectrum draws a 36-bin vertical spectral slice, with each bin mapped from low at bottom to high at top.',
      'features.chroma[pitchClass] draws short harmonic lane traces; stronger pitch classes extend farther from the right edge.',
      'features.voicing[] adds string/fret note markers at pitch-class-derived heights, sized by candidate confidence.',
      'features.guitarEvents[] add right-edge flashes and short leftward tails by event strength, type, and age.',
      'features.bendCents bends the current pitch trace up or down from the note head.'
    ],
    controlMappings: [
      'controls.scrollSpeed -> controls.motionAmount -> history scroll speed.',
      'controls.laneGain -> controls.scaleAmount -> pitch/spectrum/activity thickness.',
      'controls.historyFade -> background erase alpha.',
      'controls.eventAccent -> controls.colorAmount -> event, bend, and playhead emphasis.'
    ],
    visualMappings: [
      'The right edge is the current moment.',
      'Higher notes are drawn higher.',
      'Louder or busier passages become thicker, brighter, and longer.',
      'Older details move left and fade like a side-scroller game trail.'
    ]
  },
  forms3d: {
    description: 'A central 3D form where loudness, pitch class, spectrum brightness, note stability, and attacks drive material, mesh geometry, spin, and particles.',
    dspMappings: [
      'frame.spectralCentroid sets material warmth and roughness.',
      'frame.high increases material saturation and y rotation speed.',
      'frame.rms sets emissive strength and mesh scale.',
      'frame.low adds extra mesh scale.',
      'features.pitchConfidence > 0.42 and features.noteStability > 0.45 switch geometry by pitch class from features.pitchHz.',
      'frame.mid, frame.high, and frame.noteStability control mesh rotation on x/y/z axes.',
      'frame.onset > 0.2 triggers particle spawning; particles use frame.onset, frame.high, frame.peak, frame.low, frame.mid, and frame.hue.'
    ],
    controlMappings: [
      'controls.formScale -> controls.scaleAmount -> mesh scale response.',
      'controls.spin -> controls.motionAmount -> mesh rotation speed.',
      'controls.particleBurst -> controls.colorAmount -> particle spawn count.',
      'controls.morphRate is stored for the mode but currently has no direct renderer formula.'
    ],
    visualMappings: [
      'Stable pitched notes choose one of twelve chromatic geometries.',
      'Louder playing makes the form breathe larger and glow.',
      'High/mid energy makes the form spin faster.',
      'Attacks emit short-lived particles around the form.'
    ]
  },
  spectralField3d: {
    description: 'A 3D point field where seeded particles are assigned low, mid, or high bands and orbit based on spectral energy.',
    dspMappings: [
      'Each seed chooses frame.low, frame.mid, or frame.high as its bandValue.',
      'bandValue and frame.onset set radial pulse: 0.35 + bandValue * 2.4 * controls.scaleAmount + frame.onset * 0.8.',
      'frame.high adds group y rotation speed.',
      'frame.spectralCentroid affects z radius and y-wave phase.',
      'frame.mid increases y-wave amplitude.',
      'frame.hue and band index set per-point color.'
    ],
    controlMappings: [
      'controls.fieldSpread -> controls.scaleAmount -> point-cloud radius expansion.',
      'controls.orbitSpeed -> controls.motionAmount -> group rotation and seed angle advance.',
      'controls.pointSize -> controls.colorAmount and direct PointsMaterial size.',
      'controls.density -> active seed count; inactive seeds move offscreen.'
    ],
    visualMappings: [
      'Low, mid, and high bands occupy different vertical regions.',
      'Onsets push the full field outward.',
      'Brighter spectra create deeper z motion.',
      'Density controls whether the map reads sparse or filled.'
    ]
  },
  chromaConstellation3d: {
    description: 'A 12-node pitch-class constellation where chroma, detected chord tones, bends, vibrato, and attacks form a rotating harmonic diagram.',
    dspMappings: [
      'features.chroma[pitchClass] sets each node radius, scale, opacity, lightness, and emissive strength.',
      'features.chordRoot, chordQuality, and chordConfidence generate chord pitch classes for connecting lines.',
      'Chord membership adds radius, scale, lightness, and emissive energy to chord-tone nodes.',
      'features.chordConfidence sets line opacity and line color intensity.',
      'frame.vibratoRate and abs(features.bendCents) set z-axis orbit speed.',
      'frame.vibratoDepth and frame.brightness set node z displacement.',
      'frame.attack or frame.onset spawns chroma particles from active pitch classes.'
    ],
    controlMappings: [
      'controls.nodeScale -> controls.scaleAmount -> chroma radius spread.',
      'controls.chordTension -> controls.colorAmount -> extra chord-tone radius.',
      'controls.orbitSpeed -> controls.motionAmount -> harmonic orbit speed.',
      'controls.particleBloom is stored for the mode but current particles use chroma, attack, onset, and opacity.'
    ],
    visualMappings: [
      'Pitch classes brighten and move outward as chroma rises.',
      'Detected chord tones connect into a harmonic polygon.',
      'Bends and vibrato rotate the constellation.',
      'Attacks burst particles from active pitch-class nodes.'
    ]
  },
  guitarGlyph3d: {
    description: 'A 3D fretboard glyph that combines voicing candidates, current string/fret detection, spectrum bars, technique events, and bend motion.',
    dspMappings: [
      'features.harmonicRatio sets string material opacity.',
      'features.guitarTechniqueConfidence and frame.rms set overall group scale.',
      'features.bendCents drives y rotation.',
      'features.fretNumber and frame.attack light matching fret bars.',
      'features.voicing[] maps candidate fretNumber/stringNumber to note node x/y positions.',
      'features.voicing[].confidence sets note node z position, scale, opacity, lightness, and emissive energy.',
      'features.voicing[].pitchClass plus frame.hue sets note-node color.',
      'features.stringNumber marks the active candidate and adds frame.onset/attack emphasis.',
      'features.logSpectrum[0..35] maps to 36 bar heights below the fretboard.',
      'features.guitarEvents[] spawn event particles at event or current string/fret positions.'
    ],
    controlMappings: [
      'controls.fretboardTilt -> controls.motionAmount and direct x rotation.',
      'controls.fretSpan -> fret construction and candidate fret-to-x mapping.',
      'controls.noteGlow -> controls.colorAmount -> note emissive color and emissiveIntensity.',
      'controls.spectrumHeight -> controls.scaleAmount -> logSpectrum bar height.'
    ],
    visualMappings: [
      'Detected notes become glowing nodes on the 3D neck.',
      'Frequency content rises as a spectrum skyline under the strings.',
      'Events throw particles from the played string/fret area.',
      'Bends tilt the whole glyph laterally.'
    ]
  },
  stringResonator3d: {
    description: 'Six modeled 3D strings where voicing, active string detection, event energy, vibrato, bends, pick noise, and muting become wave motion.',
    dspMappings: [
      'features.guitarEvents[].stringNumber and strength raise per-string stored energy.',
      'features.voicing[].confidence contributes voicingEnergy per string.',
      'features.stringNumber with features.pitchConfidence contributes directEnergy to the active string.',
      'features.muteAmount damps wave amplitude and speeds stored-energy decay.',
      'abs(features.bendCents) / 180 contributes bend energy and y rotation.',
      'frame.vibratoDepth, frame.vibratoRate, and features.pickNoise set wave amplitude/frequency.',
      'features.fretNumber focuses the wave envelope around the fret position.',
      'features.harmonicRatio, frame.rms, and frame.low affect material opacity and group scale.'
    ],
    controlMappings: [
      'controls.stringCount -> number of visible modeled strings.',
      'controls.resonanceDecay -> controls.motionAmount and per-string event-energy decay.',
      'controls.waveDepth -> controls.scaleAmount -> displacement amplitude.',
      'controls.bendSensitivity -> controls.colorAmount -> bend contribution to wave amplitude and rotation.'
    ],
    visualMappings: [
      'Plucks and note events inject energy into individual strings.',
      'Muted playing shortens and damps the waves.',
      'Vibrato and bends visibly pull the string displacement.',
      'Fret detection localizes the resonant envelope along the string length.'
    ]
  },
  techniqueShard3d: {
    description: 'A fractured 3D shard field where technique confidence, pick noise, muting, bends, harmonic content, chroma, and chord confidence drive scatter and fracture.',
    dspMappings: [
      'techniqueIntensity = clamp01(guitarTechniqueConfidence * 0.55 + max(pickNoise, muteAmount, vibratoDepth, abs(bendCents)/180, chordConfidence, harmonicRatio) * 0.45).',
      'features.pickNoise adds rough x displacement, spin speed, and shard x scale.',
      'features.muteAmount pulls shards backward in z and increases shard z scale.',
      'abs(features.bendCents) / 180 bends angular placement and increases group rotation.',
      'features.harmonicRatio and frame.mid set shard scatter radius.',
      'frame.low affects shard vertical spread; frame.brightness affects z radius.',
      'frame.rms, frame.attack, and techniqueIntensity set shard length/fracture scale.',
      'features.guitarTechnique selects hue bias; features.guitarTechniqueConfidence raises saturation and opacity.',
      'features.chroma[pitchClass] and features.chordConfidence draw harmonic rings below the shards.'
    ],
    controlMappings: [
      'controls.shardCount -> active instanced shard count.',
      'controls.scatter -> controls.colorAmount -> shard radius multiplier.',
      'controls.spin -> controls.motionAmount -> group rotation and per-shard spin.',
      'controls.fracture -> controls.scaleAmount -> shard length from rms, attack, and techniqueIntensity.'
    ],
    visualMappings: [
      'Confident technique detection makes fragments longer, brighter, and more saturated.',
      'Pick noise roughens placement and widens shards.',
      'Muting compacts the field while making shard forms chunkier.',
      'Chroma and chord confidence draw a pitch ring underneath the fracture field.'
    ]
  }
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

type RailKey = 'input' | 'midi' | 'analysis' | 'layers' | 'dsp';
type MinimizedRails = Record<RailKey, boolean>;
type SignalAnalysisState = 'idle' | 'recording' | 'analyzing' | 'complete' | 'error';
type LibraryRecordingState = 'idle' | 'recording' | 'saving' | 'error';
type MidiAccessState = 'unsupported' | 'idle' | 'requesting' | 'ready' | 'denied';

type MidiInputOption = {
  id: string;
  name: string;
};

type MidiLearnState = {
  target: MidiMappingTarget;
  label: string;
  range: MidiMappingRange;
  expiresAt: number;
};

type MidiConflictState = {
  candidate: MidiMapping;
  conflicts: MidiMapping[];
};

type MidiRuntimeState = {
  pickupArmed: boolean;
  pickupValue: number;
  lastNormalizedValue: number | null;
  lastCcValue: number | null;
  smoothedValue: number | null;
  targetValue: number | null;
  lastAppliedValue: number | null;
};

type SliderMidiProps = {
  mapping?: MidiMapping;
  learning: boolean;
  disabled: boolean;
  onLearn: () => void;
  onForget: () => void;
};

const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  width: 1920,
  height: 1080,
  transparentBackground: false,
  accumulationAlpha: 0.16
};

export function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [config, setConfig] = useState<AudioStartConfig>(loadConfig);
  const [layers, setLayers] = useState<VisualLayer[]>(loadLayers);
  const [midiMappings, setMidiMappings] = useState<MidiMapping[]>([]);
  const [presets, setPresets] = useState<VisualLayerPreset[]>(loadPresets);
  const [captureSettings, setCaptureSettings] = useState<CaptureSettings>(DEFAULT_CAPTURE_SETTINGS);
  const [presetName, setPresetName] = useState('New preset');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [recording, setRecording] = useState(false);
  const [videoRecording, setVideoRecording] = useState(false);
  const [visualFullscreen, setVisualFullscreen] = useState(false);
  const [visualQuality, setVisualQuality] = useState<VisualRenderQuality>(loadVisualQuality);
  const [signalAnalysisState, setSignalAnalysisState] = useState<SignalAnalysisState>('idle');
  const [signalAnalysisStatus, setSignalAnalysisStatus] = useState('Ready to analyze');
  const [signalAnalysisWaveform, setSignalAnalysisWaveform] = useState<number[]>([]);
  const [signalAnalysisReport, setSignalAnalysisReport] = useState<ActivityAnalysisReport | null>(null);
  const [signalAnalysisModalOpen, setSignalAnalysisModalOpen] = useState(false);
  const [libraryItems, setLibraryItems] = useState<AudioLibraryItem[]>([]);
  const [libraryStatus, setLibraryStatus] = useState('Library ready');
  const [libraryRecordingState, setLibraryRecordingState] = useState<LibraryRecordingState>('idle');
  const [libraryRecordingWaveform, setLibraryRecordingWaveform] = useState<number[]>([]);
  const [libraryRecordingName, setLibraryRecordingName] = useState('Input take');
  const [playbackState, setPlaybackState] = useState<PlaybackTransportState>(EMPTY_PLAYBACK_STATE);
  const [midiAccessState, setMidiAccessState] = useState<MidiAccessState>(() =>
    typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function' ? 'idle' : 'unsupported'
  );
  const [midiStatus, setMidiStatus] = useState('MIDI access has not been requested.');
  const [midiInputs, setMidiInputs] = useState<MidiInputOption[]>([]);
  const [selectedMidiInputId, setSelectedMidiInputId] = useState('');
  const [selectedMidiChannel, setSelectedMidiChannel] = useState<MidiChannel>('omni');
  const [midiLearn, setMidiLearn] = useState<MidiLearnState | null>(null);
  const [midiLearnTick, setMidiLearnTick] = useState(Date.now());
  const [midiConflict, setMidiConflict] = useState<MidiConflictState | null>(null);
  const [minimizedRails, setMinimizedRails] = useState<MinimizedRails>({
    input: false,
    midi: false,
    analysis: false,
    layers: false,
    dsp: false
  });
  const [minimizedLayerIds, setMinimizedLayerIds] = useState<string[]>([]);
  const [recordingStatus, setRecordingStatus] = useState('Ready to record');
  const [status, setStatus] = useState<AudioStatus>({
    running: false,
    mode: DEFAULT_START_CONFIG.mode,
    nativeAvailable: false,
    message: 'Starting.'
  });
  const { latest, latestRef } = useAudioFeatures();
  const visualSynthRef = useRef<VisualSynthHandle | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const signalAnalysisPollRef = useRef<number | null>(null);
  const libraryRecordingPollRef = useRef<number | null>(null);
  const layersRef = useRef(layers);
  const midiMappingsRef = useRef(midiMappings);
  const midiLearnRef = useRef<MidiLearnState | null>(null);
  const midiConflictRef = useRef<MidiConflictState | null>(null);
  const midiSelectionRef = useRef<{ inputId: string; channel: MidiChannel }>({ inputId: '', channel: 'omni' });
  const midiAccessRef = useRef<MIDIAccess | null>(null);
  const midiInputPortsRef = useRef<MIDIInput[]>([]);
  const midiRuntimeRef = useRef(new Map<string, MidiRuntimeState>());
  const midiRafRef = useRef<number | null>(null);
  const handleMidiMessageRef = useRef<(input: MIDIInput, event: MIDIMessageEvent) => void>(() => undefined);
  const audio = useMemo(() => getAudioClient(), []);
  const playback = useMemo(() => getPlaybackClient(), []);
  const library = useMemo(() => getLibraryClient(), []);
  const art = useMemo(() => getArtClient(), []);
  const layerDragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  useEffect(() => {
    midiMappingsRef.current = midiMappings;
    const liveIds = new Set(midiMappings.map((mapping) => mapping.id));
    Array.from(midiRuntimeRef.current.keys()).forEach((id) => {
      if (!liveIds.has(id)) {
        midiRuntimeRef.current.delete(id);
      }
    });
  }, [midiMappings]);

  useEffect(() => {
    midiLearnRef.current = midiLearn;
  }, [midiLearn]);

  useEffect(() => {
    midiConflictRef.current = midiConflict;
  }, [midiConflict]);

  useEffect(() => {
    midiSelectionRef.current = { inputId: selectedMidiInputId, channel: selectedMidiChannel };
  }, [selectedMidiInputId, selectedMidiChannel]);

  useEffect(() => {
    return () => {
      if (midiRafRef.current !== null) {
        window.cancelAnimationFrame(midiRafRef.current);
      }
      midiInputPortsRef.current.forEach((input) => {
        input.onmidimessage = null;
      });
    };
  }, []);

  useEffect(() => {
    audio.listDevices().then(setDevices).catch(() => setDevices([]));
    library.list().then(setLibraryItems).catch(() => setLibraryItems([]));
    const off = audio.onStatus(setStatus);
    audio.start(config).catch((error) => {
      setStatus((prev) => ({ ...prev, message: error instanceof Error ? error.message : 'Unable to start audio.' }));
    });
    return () => {
      off();
    };
  }, [audio, library]);

  useEffect(() => {
    const off = playback.subscribe(setPlaybackState);
    const timer = window.setInterval(() => {
      setPlaybackState(playback.getState());
    }, 80);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [playback]);

  useEffect(() => {
    return () => {
      stopSignalAnalysisPolling(signalAnalysisPollRef);
      stopSignalAnalysisPolling(libraryRecordingPollRef);
    };
  }, []);

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
    if (!midiLearn) {
      return;
    }

    const timer = window.setInterval(() => {
      const now = Date.now();
      setMidiLearnTick(now);
      if (now >= midiLearn.expiresAt) {
        setMidiLearn(null);
        setMidiConflict(null);
        setMidiStatus('MIDI learn timed out.');
      }
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [midiLearn]);

  useEffect(() => {
    handleMidiMessageRef.current = handleMidiMessage;
  });

  useEffect(() => {
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (midiLearn) {
        cancelMidiLearn('MIDI learn canceled.');
        return;
      }
      if (!visualFullscreen) {
        return;
      }
      setVisualFullscreen(false);
    };

    window.addEventListener('keydown', exitOnEscape);
    return () => {
      window.removeEventListener('keydown', exitOnEscape);
    };
  }, [midiLearn, visualFullscreen]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === config.deviceId),
    [devices, config.deviceId]
  );
  const selectedLibraryItem = useMemo(
    () => libraryItems.find((item) => item.id === config.playbackItemId) ?? libraryItems[0] ?? null,
    [libraryItems, config.playbackItemId]
  );
  const channelCount = selectedDevice?.inputChannels ?? 2;
  const midiReady = midiAccessState === 'ready' && Boolean(selectedMidiInputId);
  const midiLearnRemainingSeconds = midiLearn ? Math.max(0, Math.ceil((midiLearn.expiresAt - midiLearnTick) / 1000)) : 0;

  async function requestMidiAccess() {
    if (typeof navigator.requestMIDIAccess !== 'function') {
      setMidiAccessState('unsupported');
      setMidiStatus('Web MIDI is not available in this runtime.');
      return;
    }

    setMidiAccessState('requesting');
    setMidiStatus('Requesting MIDI access...');
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false, software: true });
      midiAccessRef.current = access;
      setMidiAccessState('ready');
      access.onstatechange = () => refreshMidiInputs(access);
      refreshMidiInputs(access);
    } catch (error) {
      midiAccessRef.current = null;
      setMidiAccessState('denied');
      setMidiStatus(formatMidiAccessError(error));
    }
  }

  function refreshMidiInputs(access: MIDIAccess | null = midiAccessRef.current) {
    if (!access) {
      setMidiInputs([]);
      setSelectedMidiInputId('');
      return;
    }

    midiInputPortsRef.current.forEach((input) => {
      input.onmidimessage = null;
    });

    const ports = Array.from(access.inputs.values()).filter((input) => input.state !== 'disconnected');
    ports.forEach((input) => {
      input.onmidimessage = (event) => handleMidiMessageRef.current(input, event);
    });
    midiInputPortsRef.current = ports;

    const options = ports.map((input) => ({
      id: input.id,
      name: formatMidiInputName(input)
    }));
    setMidiInputs(options);
    setSelectedMidiInputId((current) => {
      if (options.some((option) => option.id === current)) {
        return current;
      }
      return options[0]?.id ?? '';
    });
    setMidiStatus(options.length ? `${options.length} MIDI input${options.length === 1 ? '' : 's'} available.` : 'No MIDI inputs found.');
  }

  function handleMidiMessage(input: MIDIInput, event: MIDIMessageEvent) {
    if (!event.data || event.data.length < 3) {
      return;
    }
    const [statusByte, cc, value] = Array.from(event.data);
    if (statusByte === undefined || cc === undefined || value === undefined) {
      return;
    }

    const command = statusByte & 0xf0;
    if (command !== 0xb0) {
      return;
    }

    const channel = (statusByte & 0x0f) + 1;
    const selection = midiSelectionRef.current;
    if (input.id !== selection.inputId || !channelMatches(selection.channel, channel)) {
      return;
    }

    const learn = midiLearnRef.current;
    if (learn) {
      if (midiConflictRef.current) {
        return;
      }
      const candidate: MidiMapping = {
        id: createId(),
        source: {
          inputId: input.id,
          inputName: formatMidiInputName(input),
          channel: selection.channel,
          cc
        },
        target: learn.target,
        range: learn.range
      };
      const conflicts = midiMappingsRef.current.filter(
        (mapping) => !sameMidiTarget(mapping.target, candidate.target) && midiSourcesOverlap(mapping.source, candidate.source)
      );
      if (conflicts.length) {
        setMidiConflict({ candidate, conflicts });
        setMidiStatus(`CC ${cc} is already mapped. Confirm replace or cancel.`);
        return;
      }
      completeMidiLearn(candidate, []);
      return;
    }

    applyMidiCc(input.id, channel, cc, value);
  }

  useEffect(() => {
    let cancelled = false;
    playback
      .load(selectedLibraryItem, {
        inputGain: config.inputGain,
        gateThreshold: config.gateThreshold
      })
      .then(() => {
        if (!cancelled && selectedLibraryItem) {
          setLibraryStatus(`${selectedLibraryItem.name} ready`);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLibraryStatus(error instanceof Error ? error.message : 'Unable to load Playback item');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [playback, selectedLibraryItem, config.inputGain, config.gateThreshold]);

  async function start(mode: AudioMode = config.mode) {
    const next = { ...config, mode, playbackItemId: mode === 'playback' ? selectedLibraryItem?.id : config.playbackItemId };
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

  async function togglePlayback() {
    if (!selectedLibraryItem) {
      setLibraryStatus('Import or record a Playback library item first.');
      return;
    }

    if (playbackState.playing) {
      playback.pause();
      setLibraryStatus('Playback paused');
      return;
    }

    await start('playback');
  }

  async function resetPlayback() {
    playback.reset();
    if (config.mode === 'playback') {
      await audio.stop().catch(() => undefined);
    }
    setLibraryStatus('Playback reset');
  }

  async function startSignalAnalysis() {
    if (signalAnalysisPollRef.current || signalAnalysisState === 'analyzing') {
      return;
    }

    try {
      setSignalAnalysisReport(null);
      setSignalAnalysisModalOpen(false);
      setSignalAnalysisWaveform([]);
      setSignalAnalysisState('recording');
      setSignalAnalysisStatus(`Recording ${selectedDevice?.name ?? 'default input'}`);
      await audio.startAnalysisRecording(config);
      signalAnalysisPollRef.current = window.setInterval(() => {
        void audio.getAnalysisRecordingWaveform().then((preview) => {
          setSignalAnalysisWaveform(preview.waveform);
          setSignalAnalysisStatus(`Recording ${formatDuration(preview.durationMs)} (${preview.totalSamples.toLocaleString()} samples)`);
        }).catch(() => undefined);
      }, 100);
      setSignalAnalysisStatus(`Recording ${selectedDevice?.name ?? 'default input'}`);
    } catch (error) {
      stopSignalAnalysisPolling(signalAnalysisPollRef);
      setSignalAnalysisState('error');
      setSignalAnalysisStatus(error instanceof Error ? error.message : 'Unable to start analysis recording');
    }
  }

  async function stopSignalAnalysis() {
    if (!signalAnalysisPollRef.current) {
      return;
    }

    stopSignalAnalysisPolling(signalAnalysisPollRef);
    let recording: Awaited<ReturnType<typeof audio.stopAnalysisRecording>>;
    try {
      recording = await audio.stopAnalysisRecording();
    } catch (error) {
      setSignalAnalysisState('error');
      setSignalAnalysisStatus(error instanceof Error ? error.message : 'Unable to stop analysis recording');
      return;
    }
    const samples = Float32Array.from(recording.samples);
    setSignalAnalysisWaveform(createWaveformPreview(samples));
    if (samples.length < recording.sampleRate * 0.1) {
      setSignalAnalysisState('error');
      setSignalAnalysisStatus('Recording was too short to analyze');
      return;
    }

    setSignalAnalysisState('analyzing');
    setSignalAnalysisStatus(`Analyzing ${formatDuration((samples.length / recording.sampleRate) * 1000)} at 1 ms resolution`);
    try {
      const report = await analyzeAudioRecording({ samples, sampleRate: recording.sampleRate });
      setSignalAnalysisReport(report);
      setSignalAnalysisModalOpen(true);
      setSignalAnalysisState('complete');
      setSignalAnalysisStatus(`Analyzed ${formatDuration(report.durationMs)}`);
    } catch (error) {
      setSignalAnalysisState('error');
      setSignalAnalysisStatus(error instanceof Error ? error.message : 'Analysis failed');
    }
  }

  async function refreshLibrary() {
    try {
      const items = await library.list();
      setLibraryItems(items);
      if (!config.playbackItemId && items[0]) {
        setConfig((prev) => ({ ...prev, playbackItemId: items[0].id }));
      }
      setLibraryStatus(`${items.length} library item${items.length === 1 ? '' : 's'}`);
    } catch (error) {
      setLibraryStatus(error instanceof Error ? error.message : 'Unable to read Playback library');
    }
  }

  async function importLibraryItems() {
    try {
      const items = await library.import();
      setLibraryItems(items);
      if (items[0]) {
        updateStartConfig({ playbackItemId: items[0].id }, config.mode === 'playback');
      }
      setLibraryStatus(`${items.length} library item${items.length === 1 ? '' : 's'}`);
    } catch (error) {
      setLibraryStatus(error instanceof Error ? error.message : 'Unable to import audio');
    }
  }

  async function deleteSelectedLibraryItem() {
    if (!selectedLibraryItem) {
      return;
    }

    try {
      await library.delete(selectedLibraryItem.id);
      const nextItems = await library.list();
      setLibraryItems(nextItems);
      updateStartConfig({ playbackItemId: nextItems[0]?.id }, config.mode === 'playback');
      setLibraryStatus(`${selectedLibraryItem.name} deleted`);
    } catch (error) {
      setLibraryStatus(error instanceof Error ? error.message : 'Unable to delete library item');
    }
  }

  async function startLibraryRecording() {
    if (libraryRecordingPollRef.current || signalAnalysisState === 'recording') {
      return;
    }

    try {
      setLibraryRecordingWaveform([]);
      setLibraryRecordingState('recording');
      setLibraryStatus('Recording input to Playback library');
      await library.startRecording({ ...config, mode: 'live', deviceId: undefined });
      libraryRecordingPollRef.current = window.setInterval(() => {
        void library.getRecordingWaveform().then((preview) => {
          setLibraryRecordingWaveform(preview.waveform);
          setLibraryStatus(`Recording ${formatDuration(preview.durationMs)} (${preview.totalSamples.toLocaleString()} samples)`);
        }).catch(() => undefined);
      }, 100);
    } catch (error) {
      stopSignalAnalysisPolling(libraryRecordingPollRef);
      setLibraryRecordingState('error');
      setLibraryStatus(error instanceof Error ? error.message : 'Unable to start library recording');
    }
  }

  async function stopLibraryRecording() {
    if (!libraryRecordingPollRef.current) {
      return;
    }

    stopSignalAnalysisPolling(libraryRecordingPollRef);
    setLibraryRecordingState('saving');
    setLibraryStatus('Saving input recording');
    try {
      const result = await library.stopRecording(libraryRecordingName);
      const items = await library.list();
      setLibraryItems(items);
      setLibraryRecordingWaveform(createWaveformPreview(Float32Array.from(result.recording.samples)));
      setLibraryRecordingState('idle');
      updateStartConfig({ playbackItemId: result.item.id }, config.mode === 'playback');
      setLibraryStatus(`${result.item.name} saved to Playback`);
    } catch (error) {
      setLibraryRecordingState('error');
      setLibraryStatus(error instanceof Error ? error.message : 'Unable to save recording');
    }
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
    const mode = kind === '2d' ? 'sideScroller2d' : 'spectralField3d';
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

  function updateLayerControlFromUi(id: string, key: keyof VisualLayerControls, value: number | boolean) {
    rearmMidiMappingsForTarget({ layerId: id, control: key }, typeof value === 'number' ? value : null);
    updateLayerControl(id, key, value);
  }

  function applyMidiLayerControl(id: string, key: keyof VisualLayerControls, value: number) {
    setLayers((prev) =>
      prev.map((layer) =>
        layer.id === id
          ? {
              ...layer,
              controls: syncDerivedLayerControls(layer.mode, {
                ...layer.controls,
                [key]: value
              })
            }
          : layer
      )
    );
  }

  function startMidiLearn(target: MidiMappingTarget, label: string, range: MidiMappingRange) {
    if (!midiReady) {
      setMidiStatus(midiAccessState === 'ready' ? 'Choose a MIDI input before learning.' : 'Enable MIDI before learning a control.');
      return;
    }
    setMidiConflict(null);
    setMidiLearn({
      target,
      label,
      range,
      expiresAt: Date.now() + MIDI_LEARN_TIMEOUT_MS
    });
    setMidiLearnTick(Date.now());
    setMidiStatus(`Learning ${label}. Move a CC control.`);
  }

  function cancelMidiLearn(message = 'MIDI learn canceled.') {
    setMidiLearn(null);
    setMidiConflict(null);
    setMidiStatus(message);
  }

  function completeMidiLearn(candidate: MidiMapping, conflicts: MidiMapping[]) {
    setMidiMappings((prev) => {
      const conflictIds = new Set(conflicts.map((mapping) => mapping.id));
      return [
        ...prev.filter((mapping) => !sameMidiTarget(mapping.target, candidate.target) && !conflictIds.has(mapping.id)),
        candidate
      ];
    });
    armMidiMapping(candidate, getLayerControlValue(candidate.target));
    setMidiLearn(null);
    setMidiConflict(null);
    setMidiStatus(`Mapped ${formatMidiSource(candidate.source)}.`);
  }

  function forgetMidiMapping(target: MidiMappingTarget) {
    setMidiMappings((prev) => prev.filter((mapping) => !sameMidiTarget(mapping.target, target)));
    setMidiStatus('MIDI mapping forgotten.');
  }

  function forgetAllMidiMappings() {
    setMidiMappings([]);
    setMidiStatus('All MIDI mappings forgotten.');
  }

  function applyMidiCc(inputId: string, channel: number, cc: number, ccValue: number) {
    const normalized = ccValue / 127;
    midiMappingsRef.current.forEach((mapping) => {
      if (mapping.source.inputId !== inputId || mapping.source.cc !== cc || !channelMatches(mapping.source.channel, channel)) {
        return;
      }
      const layerValue = getLayerControlValue(mapping.target);
      if (layerValue === null) {
        return;
      }
      const runtime = getMidiRuntime(mapping);
      if (runtime.lastCcValue === ccValue && !runtime.pickupArmed) {
        return;
      }

      if (runtime.pickupArmed) {
        const pickedUp = midiPickupReached(runtime, mapping.range, normalized);
        runtime.lastNormalizedValue = normalized;
        runtime.lastCcValue = ccValue;
        if (!pickedUp) {
          return;
        }
        runtime.pickupArmed = false;
        runtime.smoothedValue = layerValue;
      }

      runtime.lastNormalizedValue = normalized;
      runtime.lastCcValue = ccValue;
      runtime.targetValue = quantizeMidiValue(scaleMidiValue(normalized, mapping.range), mapping.range);
    });
    scheduleMidiFrame();
  }

  function scheduleMidiFrame() {
    if (midiRafRef.current !== null) {
      return;
    }
    midiRafRef.current = window.requestAnimationFrame(flushMidiFrame);
  }

  function flushMidiFrame() {
    midiRafRef.current = null;
    let hasPending = false;

    midiMappingsRef.current.forEach((mapping) => {
      const runtime = midiRuntimeRef.current.get(mapping.id);
      if (!runtime || runtime.targetValue === null || runtime.pickupArmed) {
        return;
      }

      const current = runtime.smoothedValue ?? getLayerControlValue(mapping.target) ?? runtime.targetValue;
      const delta = runtime.targetValue - current;
      const threshold = Math.max(mapping.range.step / 2, 0.000001);
      const next = Math.abs(delta) <= threshold ? runtime.targetValue : current + delta * MIDI_SMOOTHING_AMOUNT;
      const quantized = quantizeMidiValue(next, mapping.range);
      runtime.smoothedValue = next;

      if (runtime.lastAppliedValue !== quantized) {
        runtime.lastAppliedValue = quantized;
        applyMidiLayerControl(mapping.target.layerId, mapping.target.control, quantized);
      }

      if (Math.abs(runtime.targetValue - next) > threshold) {
        hasPending = true;
      } else {
        runtime.smoothedValue = runtime.targetValue;
      }
    });

    if (hasPending) {
      midiRafRef.current = window.requestAnimationFrame(flushMidiFrame);
    }
  }

  function getMidiRuntime(mapping: MidiMapping): MidiRuntimeState {
    let runtime = midiRuntimeRef.current.get(mapping.id);
    if (!runtime) {
      runtime = createMidiRuntime(mapping, getLayerControlValue(mapping.target));
      midiRuntimeRef.current.set(mapping.id, runtime);
    }
    return runtime;
  }

  function armMidiMapping(mapping: MidiMapping, currentValue: number | null) {
    midiRuntimeRef.current.set(mapping.id, createMidiRuntime(mapping, currentValue));
  }

  function rearmMidiMappingsForTarget(target: MidiMappingTarget, currentValue: number | null) {
    midiMappingsRef.current.forEach((mapping) => {
      if (sameMidiTarget(mapping.target, target)) {
        armMidiMapping(mapping, currentValue);
      }
    });
  }

  function getLayerControlValue(target: MidiMappingTarget): number | null {
    const layer = layersRef.current.find((candidate) => candidate.id === target.layerId);
    const value = layer?.controls[target.control];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

  function reorderLayers(activeId: string, overId: string) {
    setLayers((prev) => {
      const oldIndex = prev.findIndex((layer) => layer.id === activeId);
      const newIndex = prev.findIndex((layer) => layer.id === overId);
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
        return prev;
      }
      return arrayMove(prev, oldIndex, newIndex);
    });
  }

  function handleLayerDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    reorderLayers(String(active.id), String(over.id));
  }

  function removeLayer(id: string) {
    setLayers((prev) => prev.filter((layer) => layer.id !== id));
    setMinimizedLayerIds((prev) => prev.filter((layerId) => layerId !== id));
    setMidiMappings((prev) => prev.filter((mapping) => mapping.target.layerId !== id));
  }

  function savePreset() {
    const name = presetName.trim() || `Preset ${presets.length + 1}`;
    const preset: VisualLayerPreset = {
      id: createId(),
      name,
      layers: cloneLayers(layers),
      midiMappings: cloneMidiMappings(midiMappings),
      createdAt: Date.now()
    };
    setPresets((prev) => [...prev, preset]);
    setSelectedPresetId(preset.id);
  }

  function loadPreset() {
    const preset = presets.find((item) => item.id === selectedPresetId);
    if (preset) {
      const nextLayers = cloneLayers(preset.layers);
      const nextMappings = normalizeMidiMappings(preset.midiMappings, new Set(nextLayers.map((layer) => layer.id)));
      setLayers(nextLayers);
      setMidiMappings(nextMappings);
      nextMappings.forEach((mapping) => armMidiMapping(mapping, getLayerControlValueFromLayers(nextLayers, mapping.target)));
      setMinimizedLayerIds([]);
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

  function toggleRail(key: RailKey) {
    setMinimizedRails((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function toggleLayerCard(id: string) {
    setMinimizedLayerIds((prev) => (prev.includes(id) ? prev.filter((layerId) => layerId !== id) : [...prev, id]));
  }

  const shellClassName = [
    'app-shell',
    minimizedRails.input ? 'input-minimized' : '',
    minimizedRails.midi ? 'midi-minimized' : '',
    minimizedRails.analysis ? 'analysis-minimized' : '',
    minimizedRails.layers ? 'layers-minimized' : '',
    minimizedRails.dsp ? 'dsp-minimized' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClassName}>
      <aside className={`control-rail ${minimizedRails.input ? 'rail-minimized' : ''}`}>
        <RailHeader
          kicker="Input"
          title={minimizedRails.input ? undefined : status.mode === 'playback' ? 'Playback' : 'Live audio'}
          minimized={minimizedRails.input}
          onToggle={() => toggleRail('input')}
        />
        {!minimizedRails.input ? (
          <>
        <TunerPanel features={latest} />

        <section className="control-group">
          <label>
            <ControlLabel tooltip={CONTROL_TOOLTIPS.inputSource}>Input source</ControlLabel>
          </label>
          <div className="segmented two">
            <button className={config.mode === 'live' ? 'active' : ''} onClick={() => start('live')}>
              Live
            </button>
            <button className={config.mode === 'playback' ? 'active' : ''} onClick={() => start('playback')}>
              Playback
            </button>
          </div>
        </section>

        <section className="playback-panel">
          <label>
            <ControlLabel tooltip={CONTROL_TOOLTIPS.playbackLibrary}>Playback library</ControlLabel>
          </label>
          <select
            value={selectedLibraryItem?.id ?? ''}
            onChange={(event) => updateStartConfig({ playbackItemId: event.target.value || undefined }, config.mode === 'playback')}
          >
            <option value="">No library item</option>
            {libraryItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <div className="playback-actions">
            <button type="button" onClick={importLibraryItems}>
              Import
            </button>
            <button type="button" className="secondary" onClick={refreshLibrary}>
              Refresh
            </button>
            <button type="button" className="secondary" onClick={deleteSelectedLibraryItem} disabled={!selectedLibraryItem}>
              Delete
            </button>
          </div>
          <div className="library-meta">
            {selectedLibraryItem ? (
              <>
                <span>{selectedLibraryItem.extension.toUpperCase()}</span>
                <span>{formatFileSize(selectedLibraryItem.sizeBytes)}</span>
                {playbackState.durationMs > 0 ? <span>{formatDuration(playbackState.durationMs)}</span> : null}
                <span>{selectedLibraryItem.source === 'recording' ? 'Recorded' : 'Imported'}</span>
              </>
            ) : (
              <span>Import MP3, WAV, AIF, or AIFF</span>
            )}
          </div>
          <div className="playback-transport">
            <button type="button" onClick={togglePlayback} disabled={!selectedLibraryItem}>
              {playbackState.playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" className="secondary" onClick={resetPlayback} disabled={!playbackState.loaded}>
              Reset
            </button>
            <span>
              {formatDuration(playbackState.positionMs)} / {formatDuration(playbackState.durationMs)}
            </span>
          </div>
          <PlaybackWaveformOverview state={playbackState} />
          <div className="library-recorder">
            <input value={libraryRecordingName} onInput={(event) => setLibraryRecordingName(event.currentTarget.value)} />
            <WaveformStrip values={libraryRecordingWaveform} active={libraryRecordingState === 'recording'} />
            <button
              type="button"
              onClick={libraryRecordingState === 'recording' ? stopLibraryRecording : startLibraryRecording}
              disabled={libraryRecordingState === 'saving' || signalAnalysisState === 'recording'}
            >
              {libraryRecordingState === 'recording' ? 'Save Recording' : libraryRecordingState === 'saving' ? 'Saving' : 'Record Input'}
            </button>
          </div>
          <div className={`analysis-state ${libraryRecordingState === 'recording' ? 'active' : ''} ${libraryRecordingState === 'error' ? 'warning' : ''}`}>
            {libraryStatus}
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
          </>
        ) : null}
      </aside>

      <aside className={`control-rail midi-rail ${minimizedRails.midi ? 'rail-minimized' : ''}`}>
        <RailHeader
          kicker="MIDI"
          title={minimizedRails.midi ? undefined : 'MIDI learn'}
          minimized={minimizedRails.midi}
          onToggle={() => toggleRail('midi')}
        />
        {!minimizedRails.midi ? (
          <MidiLearnPanel
            accessState={midiAccessState}
            status={midiStatus}
            inputs={midiInputs}
            selectedInputId={selectedMidiInputId}
            selectedChannel={selectedMidiChannel}
            mappingCount={midiMappings.length}
            learnLabel={midiLearn?.label ?? null}
            learnRemainingSeconds={midiLearnRemainingSeconds}
            onRequestAccess={requestMidiAccess}
            onRefresh={() => refreshMidiInputs()}
            onSelectInput={setSelectedMidiInputId}
            onSelectChannel={setSelectedMidiChannel}
            onCancelLearn={() => cancelMidiLearn()}
            onForgetAll={forgetAllMidiMappings}
          />
        ) : null}
      </aside>

      <aside className={`control-rail analysis-rail ${minimizedRails.analysis ? 'rail-minimized' : ''}`}>
        <RailHeader
          kicker="Audio Analysis"
          title={minimizedRails.analysis ? undefined : 'Signal activity'}
          minimized={minimizedRails.analysis}
          onToggle={() => toggleRail('analysis')}
        />
        {!minimizedRails.analysis ? (
          <SignalAnalysisPanel
            state={signalAnalysisState}
            status={signalAnalysisStatus}
            waveform={signalAnalysisWaveform}
            onStart={startSignalAnalysis}
            onStop={stopSignalAnalysis}
            onOpenReport={() => setSignalAnalysisModalOpen(true)}
            hasReport={Boolean(signalAnalysisReport)}
          />
        ) : null}
      </aside>

      <aside className={`layer-rail ${minimizedRails.layers ? 'rail-minimized' : ''}`}>
        <section className="layer-toolbar">
          <RailHeader
            kicker="Layers"
            title={minimizedRails.layers ? undefined : `${layers.length} active slot${layers.length === 1 ? '' : 's'}`}
            minimized={minimizedRails.layers}
            onToggle={() => toggleRail('layers')}
          />
        </section>

        {!minimizedRails.layers ? (
          <>
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

        <DndContext sensors={layerDragSensors} collisionDetection={closestCenter} onDragEnd={handleLayerDragEnd}>
          <SortableContext items={layers.map((layer) => layer.id)} strategy={verticalListSortingStrategy}>
            <div className="layer-stack">
              {layers.map((layer, index) => (
                <LayerEditor
                  key={layer.id}
                  layer={layer}
                  index={index}
                  isFirst={index === 0}
                  isLast={index === layers.length - 1}
                  isMinimized={minimizedLayerIds.includes(layer.id)}
                  midiMappings={midiMappings}
                  midiLearnTarget={midiLearn?.target ?? null}
                  midiDisabled={!midiReady}
                  onUpdate={updateLayer}
                  onUpdateControl={updateLayerControlFromUi}
                  onStartMidiLearn={startMidiLearn}
                  onForgetMidiMapping={forgetMidiMapping}
                  onMove={moveLayer}
                  onRemove={removeLayer}
                  onToggleMinimized={toggleLayerCard}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <div className="layer-add-footer">
          <div className="layer-add-row">
            <button onClick={() => addLayer('2d')}>+ 2D</button>
            <button onClick={() => addLayer('3d')}>+ 3D</button>
          </div>
        </div>
          </>
        ) : null}
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
          </>
        ) : null}
      </main>

      <aside className={`capture-rail ${minimizedRails.dsp ? 'rail-minimized' : ''}`}>
        <DspSidebar features={latest} minimized={minimizedRails.dsp} onToggle={() => toggleRail('dsp')} />

        {!minimizedRails.dsp ? (
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
        ) : null}
      </aside>
      {signalAnalysisModalOpen && signalAnalysisReport ? (
        <ActivityReportModal report={signalAnalysisReport} onClose={() => setSignalAnalysisModalOpen(false)} />
      ) : null}
      {midiConflict ? (
        <MidiConflictModal
          candidate={midiConflict.candidate}
          conflicts={midiConflict.conflicts}
          layers={layers}
          onReplace={() => completeMidiLearn(midiConflict.candidate, midiConflict.conflicts)}
          onCancel={() => {
            setMidiConflict(null);
            setMidiStatus('Move a different CC control or cancel learn.');
          }}
        />
      ) : null}
    </div>
  );
}

function RailHeader({
  kicker,
  title,
  minimized,
  onToggle
}: {
  kicker: string;
  title?: string;
  minimized: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rail-header">
      <div>
        <span className="rail-kicker">{kicker}</span>
        {title ? <strong>{title}</strong> : null}
      </div>
      <button
        className="rail-toggle"
        type="button"
        aria-label={`${minimized ? 'Maximize' : 'Minimize'} ${kicker} column`}
        title={`${minimized ? 'Maximize' : 'Minimize'} ${kicker}`}
        aria-pressed={minimized}
        onClick={onToggle}
      >
        {minimized ? '+' : '-'}
      </button>
    </div>
  );
}

function MidiLearnPanel({
  accessState,
  status,
  inputs,
  selectedInputId,
  selectedChannel,
  mappingCount,
  learnLabel,
  learnRemainingSeconds,
  onRequestAccess,
  onRefresh,
  onSelectInput,
  onSelectChannel,
  onCancelLearn,
  onForgetAll
}: {
  accessState: MidiAccessState;
  status: string;
  inputs: MidiInputOption[];
  selectedInputId: string;
  selectedChannel: MidiChannel;
  mappingCount: number;
  learnLabel: string | null;
  learnRemainingSeconds: number;
  onRequestAccess: () => void;
  onRefresh: () => void;
  onSelectInput: (inputId: string) => void;
  onSelectChannel: (channel: MidiChannel) => void;
  onCancelLearn: () => void;
  onForgetAll: () => void;
}) {
  const ready = accessState === 'ready';
  return (
    <section className="midi-panel">
      <div className="midi-panel-header">
        <label>MIDI learn</label>
        <span className={`midi-state ${ready ? 'ready' : accessState === 'denied' || accessState === 'unsupported' ? 'warning' : ''}`}>
          {ready ? 'Ready' : accessState === 'requesting' ? 'Requesting' : accessState === 'unsupported' ? 'Unavailable' : 'Off'}
        </span>
      </div>
      <div className="midi-actions">
        <button type="button" onClick={onRequestAccess} disabled={accessState === 'requesting' || ready}>
          {ready ? 'Enabled' : 'Enable'}
        </button>
        <button type="button" className="secondary" onClick={onRefresh} disabled={!ready}>
          Refresh
        </button>
      </div>
      <label>
        <ControlLabel>MIDI input</ControlLabel>
      </label>
      <select value={selectedInputId} disabled={!ready || inputs.length === 0} onChange={(event) => onSelectInput(event.target.value)}>
        <option value="">No MIDI input</option>
        {inputs.map((input) => (
          <option key={input.id} value={input.id}>
            {input.name}
          </option>
        ))}
      </select>
      <label>
        <ControlLabel>Channel</ControlLabel>
      </label>
      <select
        value={selectedChannel}
        disabled={!ready}
        onChange={(event) => onSelectChannel(event.target.value === 'omni' ? 'omni' : Number(event.target.value))}
      >
        <option value="omni">Omni</option>
        {Array.from({ length: 16 }, (_, index) => index + 1).map((channel) => (
          <option key={channel} value={channel}>
            Ch {channel}
          </option>
        ))}
      </select>
      <div className={`midi-learn-status ${learnLabel ? 'active' : ''}`}>
        {learnLabel ? (
          <>
            <span>Learning {learnLabel}</span>
            <strong>{learnRemainingSeconds}s</strong>
          </>
        ) : (
          <span>{status}</span>
        )}
      </div>
      {learnLabel ? (
        <button type="button" className="secondary" onClick={onCancelLearn}>
          Cancel learn
        </button>
      ) : null}
      <button type="button" className="secondary" onClick={onForgetAll} disabled={mappingCount === 0}>
        Forget all ({mappingCount})
      </button>
    </section>
  );
}

function MidiConflictModal({
  candidate,
  conflicts,
  layers,
  onReplace,
  onCancel
}: {
  candidate: MidiMapping;
  conflicts: MidiMapping[];
  layers: VisualLayer[];
  onReplace: () => void;
  onCancel: () => void;
}) {
  return createPortal(
    <div className="analysis-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="midi-conflict-title">
      <section className="midi-conflict-modal">
        <header className="analysis-modal-header">
          <div>
            <span>MIDI learn conflict</span>
            <h2 id="midi-conflict-title">Replace mapping?</h2>
          </div>
        </header>
        <p>
          {formatMidiSource(candidate.source)} is already mapped to{' '}
          {conflicts.map((mapping) => formatMidiTarget(mapping.target, layers)).join(', ')}.
        </p>
        <div className="midi-conflict-target">
          <span>New target</span>
          <strong>{formatMidiTarget(candidate.target, layers)}</strong>
        </div>
        <div className="midi-conflict-actions">
          <button type="button" onClick={onReplace}>
            Replace
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Keep learning
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

function SignalAnalysisPanel({
  state,
  status,
  waveform,
  hasReport,
  onStart,
  onStop,
  onOpenReport
}: {
  state: SignalAnalysisState;
  status: string;
  waveform: number[];
  hasReport: boolean;
  onStart: () => void;
  onStop: () => void;
  onOpenReport: () => void;
}) {
  const isRecording = state === 'recording';
  const isAnalyzing = state === 'analyzing';
  return (
    <section className="analysis-panel">
      <div className="analysis-panel-header">
        <span>Signal analysis</span>
        <strong>Activity</strong>
      </div>
      <WaveformStrip values={waveform} active={isRecording} />
      <button type="button" onClick={isRecording ? onStop : onStart} disabled={isAnalyzing}>
        {isRecording ? 'Stop Analysis' : isAnalyzing ? 'Analyzing' : 'Start Analysis'}
      </button>
      {hasReport && !isRecording ? (
        <button type="button" className="secondary" onClick={onOpenReport}>
          Show Report
        </button>
      ) : null}
      <div className={`analysis-state ${state === 'recording' ? 'active' : ''} ${state === 'error' ? 'warning' : ''}`}>
        {status}
      </div>
    </section>
  );
}

function ActivityReportModal({ report, onClose }: { report: ActivityAnalysisReport; onClose: () => void }) {
  return createPortal(
    <div className="analysis-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="analysis-report-title">
      <section className="analysis-modal">
        <header className="analysis-modal-header">
          <div>
            <span>Audio signal analysis</span>
            <h2 id="analysis-report-title">Activity ranking</h2>
          </div>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="analysis-summary">
          <DiagnosticStat label="Duration" valueText={formatDuration(report.durationMs)} />
          <DiagnosticStat label="Rate" valueText={`${Math.round(report.sampleRate / 1000)} kHz`} />
          <DiagnosticStat label="Metrics" valueText={`${report.rankings.length}`} />
        </div>
        <div className="analysis-modal-waveform">
          <WaveformStrip values={report.waveform} active={false} />
        </div>
        <div className="activity-ranking">
          <div className="activity-ranking-head">
            <span>Rank</span>
            <span>Input</span>
            <span>Activity</span>
            <span>Shape</span>
          </div>
          {report.rankings.map((metric, index) => (
            <ActivityMetricRow key={metric.key} metric={metric} rank={index + 1} />
          ))}
        </div>
      </section>
    </div>,
    document.body
  );
}

function ActivityMetricRow({ metric, rank }: { metric: ActivityMetricResult; rank: number }) {
  return (
    <div className="activity-row">
      <span className="activity-rank">{rank}</span>
      <div className="activity-name">
        <strong>{metric.label}</strong>
        <span>
          min {formatMetricValue(metric.min)} / max {formatMetricValue(metric.max)}
        </span>
      </div>
      <div className="activity-score">
        <strong>{metric.score.toFixed(1)}</strong>
        <div className="activity-score-track">
          <div style={{ width: `${metric.score}%` }} />
        </div>
      </div>
      <Sparkline values={metric.sparkline} />
    </div>
  );
}

function WaveformStrip({ values, active }: { values: number[]; active: boolean }) {
  return (
    <div className={`waveform-strip ${active ? 'active' : ''}`} aria-label="Recorded audio waveform">
      {values.length ? (
        values.map((value, index) => (
          <span key={index} style={{ height: `${Math.max(3, Math.min(100, value * 100))}%` }} />
        ))
      ) : (
        <em>No signal yet</em>
      )}
    </div>
  );
}

function PlaybackWaveformOverview({ state }: { state: PlaybackTransportState }) {
  const progress = state.durationMs > 0 ? Math.max(0, Math.min(1, state.positionMs / state.durationMs)) : 0;

  return (
    <div className="playback-overview" aria-label="Playback waveform overview">
      {state.waveform.length ? (
        <>
          <div className="playback-overview-bars">
            {state.waveform.map((value, index) => (
              <span key={index} style={{ height: `${Math.max(4, Math.min(100, value * 100))}%` }} />
            ))}
          </div>
          <div className="playback-overview-progress" style={{ width: `${progress * 100}%` }} />
          <div className="playback-playhead" style={{ left: `${progress * 100}%` }} />
        </>
      ) : (
        <em>No waveform loaded</em>
      )}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const width = 160;
  const height = 38;
  const points = values.length
    ? values
        .map((value, index) => {
          const x = values.length === 1 ? 0 : (index / (values.length - 1)) * width;
          const y = height - Math.max(0, Math.min(1, value)) * height;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ')
    : '';

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Activity sparkline">
      <polyline points={points} />
    </svg>
  );
}

function LayerEditor({
  layer,
  index,
  isFirst,
  isLast,
  isMinimized,
  midiMappings,
  midiLearnTarget,
  midiDisabled,
  onUpdate,
  onUpdateControl,
  onStartMidiLearn,
  onForgetMidiMapping,
  onMove,
  onRemove,
  onToggleMinimized
}: {
  layer: VisualLayer;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  isMinimized: boolean;
  midiMappings: MidiMapping[];
  midiLearnTarget: MidiMappingTarget | null;
  midiDisabled: boolean;
  onUpdate: (id: string, updater: (layer: VisualLayer) => VisualLayer) => void;
  onUpdateControl: (id: string, key: keyof VisualLayerControls, value: number | boolean) => void;
  onStartMidiLearn: (target: MidiMappingTarget, label: string, range: MidiMappingRange) => void;
  onForgetMidiMapping: (target: MidiMappingTarget) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  onToggleMinimized: (id: string) => void;
}) {
  const modeOptions = Object.entries(MODE_LABELS).filter(([mode]) => MODE_KIND[mode as VisualLayerMode] === layer.kind);
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({ id: layer.id });
  const sortableStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  };
  const cardClassName = `layer-card ${layer.enabled ? '' : 'muted'} ${isDragging ? 'dragging' : ''}`;
  const getMidiProps = (key: keyof VisualLayerControls, label: string, min: number, max: number, step: number): SliderMidiProps => {
    const target = { layerId: layer.id, control: key };
    return {
      mapping: midiMappings.find((mapping) => sameMidiTarget(mapping.target, target)),
      learning: midiLearnTarget ? sameMidiTarget(midiLearnTarget, target) : false,
      disabled: midiDisabled,
      onLearn: () => onStartMidiLearn(target, `${layer.name} ${label}`, { min, max, step }),
      onForget: () => onForgetMidiMapping(target)
    };
  };

  if (isMinimized) {
    return (
      <section ref={setNodeRef} className={`${cardClassName} layer-card-minimized`} style={sortableStyle}>
        <div className="layer-card-summary">
          <button
            ref={setActivatorNodeRef}
            className="layer-drag-handle"
            type="button"
            aria-label={`Reorder ${layer.name}`}
            title={`Reorder ${layer.name}`}
            {...attributes}
            {...listeners}
          >
            <span aria-hidden="true" />
          </button>
          <div className="layer-card-summary-main">
            <span>Layer {index + 1}</span>
            <strong>{layer.name}</strong>
          </div>
          <button
            className="layer-card-toggle"
            type="button"
            aria-label={`Maximize ${layer.name}`}
            title={`Maximize ${layer.name}`}
            aria-pressed="true"
            onClick={() => onToggleMinimized(layer.id)}
          >
            +
          </button>
        </div>
      </section>
    );
  }

  return (
    <section ref={setNodeRef} className={cardClassName} style={sortableStyle}>
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
        <button
          className="layer-card-toggle"
          type="button"
          aria-label={`Minimize ${layer.name}`}
          title={`Minimize ${layer.name}`}
          aria-pressed="false"
          onClick={() => onToggleMinimized(layer.id)}
        >
          -
        </button>
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

      <LayerModeRoadmap layer={layer} />
      <ModeSpecificControls layer={layer} onUpdateControl={onUpdateControl} getMidiProps={getMidiProps} />
      <LayerSlider label="Input drive" tooltip={CONTROL_TOOLTIPS.sensitivity} value={layer.controls.sensitivity} min={0.1} max={3} step={0.05} midi={getMidiProps('sensitivity', 'Input drive', 0.1, 3, 0.05)} onChange={(value) => onUpdateControl(layer.id, 'sensitivity', value)} />
      <LayerSlider label="Response" tooltip={CONTROL_TOOLTIPS.smoothing} value={layer.controls.smoothing} min={0} max={0.95} step={0.01} midi={getMidiProps('smoothing', 'Response', 0, 0.95, 0.01)} onChange={(value) => onUpdateControl(layer.id, 'smoothing', value)} />
      <LayerSlider label="Layer gate" tooltip={CONTROL_TOOLTIPS.layerGateThreshold} value={layer.controls.gateThreshold} min={0} max={0.5} step={0.005} midi={getMidiProps('gateThreshold', 'Layer gate', 0, 0.5, 0.005)} onChange={(value) => onUpdateControl(layer.id, 'gateThreshold', value)} />
      <LayerSlider label="Opacity" tooltip={CONTROL_TOOLTIPS.opacity} value={layer.controls.opacity} min={0} max={1} step={0.01} midi={getMidiProps('opacity', 'Opacity', 0, 1, 0.01)} onChange={(value) => onUpdateControl(layer.id, 'opacity', value)} />

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

function LayerModeRoadmap({ layer }: { layer: VisualLayer }) {
  const roadmap = MODE_ROADMAPS[layer.mode];

  return (
    <details className="layer-roadmap" open>
      <summary>
        <span>DSP map</span>
        <strong>{MODE_LABELS[layer.mode]}</strong>
      </summary>
      <p>{roadmap.description}</p>
      <div className="roadmap-current">
        <span>Drive {layer.controls.sensitivity.toFixed(2)}x</span>
        <span>Response {layer.controls.smoothing.toFixed(2)}</span>
        <span>Gate {layer.controls.gateThreshold.toFixed(3)}</span>
        <span>{layer.controls.requiresGate ? 'Hard gate' : 'Idle drift'}</span>
      </div>
      <RoadmapList title="Frame prep" items={SHARED_FRAME_ROADMAP} />
      <RoadmapList title="DSP to visual features" items={roadmap.dspMappings} />
      <RoadmapList title="Layer controls" items={roadmap.controlMappings} />
      <RoadmapList title="Resulting visual behavior" items={roadmap.visualMappings} />
    </details>
  );
}

function RoadmapList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="roadmap-section">
      <span>{title}</span>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ModeSpecificControls({
  layer,
  onUpdateControl,
  getMidiProps
}: {
  layer: VisualLayer;
  onUpdateControl: (id: string, key: keyof VisualLayerControls, value: number | boolean) => void;
  getMidiProps: (key: keyof VisualLayerControls, label: string, min: number, max: number, step: number) => SliderMidiProps;
}) {
  const control = (key: keyof VisualLayerControls, fallback: number) =>
    typeof layer.controls[key] === 'number' ? (layer.controls[key] as number) : fallback;
  const slider = (key: keyof VisualLayerControls, label: string, tooltip: string | undefined, value: number, min: number, max: number, step: number) => (
    <LayerSlider
      label={label}
      tooltip={tooltip}
      value={value}
      min={min}
      max={max}
      step={step}
      midi={getMidiProps(key, label, min, max, step)}
      onChange={(nextValue) => onUpdateControl(layer.id, key, nextValue)}
    />
  );

  if (layer.mode === 'trails2d') {
    return (
      <>
        {slider('trailFade', 'Trail fade', CONTROL_TOOLTIPS.trailFade, control('trailFade', 0.028), 0.006, 0.08, 0.001)}
        {slider('brushSize', 'Brush size', CONTROL_TOOLTIPS.brushSize, control('brushSize', 1), 0.25, 3, 0.05)}
        {slider('trailSpeed', 'Drift speed', CONTROL_TOOLTIPS.trailSpeed, control('trailSpeed', 1), 0, 3, 0.05)}
        {slider('bloom', 'Bloom', CONTROL_TOOLTIPS.bloom, control('bloom', 1), 0, 3, 0.05)}
      </>
    );
  }

  if (layer.mode === 'lineArt2d') {
    return (
      <>
        {slider('lineComplexity', 'Complexity', CONTROL_TOOLTIPS.lineComplexity, control('lineComplexity', 1), 0.3, 3, 0.05)}
        {slider('lineWeight', 'Line weight', CONTROL_TOOLTIPS.lineWeight, control('lineWeight', 1), 0.25, 3, 0.05)}
        {slider('lineDrift', 'Drift', CONTROL_TOOLTIPS.lineDrift, control('lineDrift', 1), 0, 3, 0.05)}
        {slider('symmetry', 'Symmetry', CONTROL_TOOLTIPS.symmetry, control('symmetry', 1), 0.5, 4, 0.05)}
      </>
    );
  }

  if (layer.mode === 'fretPulse2d') {
    return (
      <>
        {slider('fretSpan', 'Fret span', CONTROL_TOOLTIPS.fretSpan2d, control('fretSpan', 12), 5, 24, 1)}
        {slider('stringWarp', 'String warp', CONTROL_TOOLTIPS.stringWarp, control('stringWarp', 1), 0, 3, 0.05)}
        {slider('pulseDecay', 'Pulse decay', CONTROL_TOOLTIPS.pulseDecay, control('pulseDecay', 1), 0.25, 3, 0.05)}
        {slider('markerSize', 'Marker size', CONTROL_TOOLTIPS.markerSize, control('markerSize', 1), 0.25, 3, 0.05)}
      </>
    );
  }

  if (layer.mode === 'raindrops2d') {
    return null;
  }

  if (layer.mode === 'techniqueMap2d') {
    return (
      <>
        {slider('scrollSpeed', 'Scroll speed', CONTROL_TOOLTIPS.scrollSpeed, control('scrollSpeed', 1), 0.2, 3, 0.05)}
        {slider('laneGain', 'Lane gain', CONTROL_TOOLTIPS.laneGain, control('laneGain', 1), 0.25, 3, 0.05)}
        {slider('historyFade', 'History fade', CONTROL_TOOLTIPS.historyFade, control('historyFade', 0.035), 0.006, 0.12, 0.001)}
        {slider('eventAccent', 'Event accent', CONTROL_TOOLTIPS.eventAccent, control('eventAccent', 1), 0, 3, 0.05)}
      </>
    );
  }

  if (layer.mode === 'sideScroller2d') {
    return (
      <>
        {slider('scrollSpeed', 'Scroll speed', CONTROL_TOOLTIPS.sideScrollSpeed, control('scrollSpeed', 1.25), 0.2, 3, 0.05)}
        {slider('laneGain', 'Activity gain', CONTROL_TOOLTIPS.sidePitchGain, control('laneGain', 1.25), 0.25, 3, 0.05)}
        {slider('historyFade', 'History fade', CONTROL_TOOLTIPS.sideHistoryFade, control('historyFade', 0.014), 0.001, 0.08, 0.001)}
        {slider('eventAccent', 'Event accent', CONTROL_TOOLTIPS.sideEventAccent, control('eventAccent', 1.4), 0, 3, 0.05)}
      </>
    );
  }

  if (layer.mode === 'forms3d') {
    return (
      <>
        {slider('formScale', 'Form scale', CONTROL_TOOLTIPS.formScale, control('formScale', 1), 0.3, 3, 0.05)}
        {slider('morphRate', 'Morph rate', CONTROL_TOOLTIPS.morphRate, control('morphRate', 1), 0, 3, 0.05)}
        {slider('spin', 'Spin', CONTROL_TOOLTIPS.spinForms, control('spin', 1), 0, 3, 0.05)}
        {slider('particleBurst', 'Particle burst', CONTROL_TOOLTIPS.particleBurst, control('particleBurst', 1), 0, 3, 0.05)}
      </>
    );
  }

  if (layer.mode === 'spectralField3d') {
    return (
      <>
        {slider('fieldSpread', 'Field spread', CONTROL_TOOLTIPS.fieldSpread, control('fieldSpread', 1), 0.3, 3, 0.05)}
        {slider('orbitSpeed', 'Orbit speed', CONTROL_TOOLTIPS.orbitSpeedSpectral, control('orbitSpeed', 1), 0, 3, 0.05)}
        {slider('pointSize', 'Point size', CONTROL_TOOLTIPS.pointSize, control('pointSize', 1), 0.25, 3, 0.05)}
        {slider('density', 'Density', CONTROL_TOOLTIPS.density, control('density', 1), 0.25, 1, 0.05)}
      </>
    );
  }

  if (layer.mode === 'chromaConstellation3d') {
    return (
      <>
        {slider('nodeScale', 'Node scale', CONTROL_TOOLTIPS.nodeScale, control('nodeScale', 1), 0.3, 3, 0.05)}
        {slider('chordTension', 'Chord tension', CONTROL_TOOLTIPS.chordTension, control('chordTension', 1), 0, 3, 0.05)}
        {slider('orbitSpeed', 'Orbit', CONTROL_TOOLTIPS.orbitChroma, control('orbitSpeed', 1), 0, 3, 0.05)}
        {slider('particleBloom', 'Particle bloom', CONTROL_TOOLTIPS.particleBloom, control('particleBloom', 1), 0, 3, 0.05)}
      </>
    );
  }

  if (layer.mode === 'guitarGlyph3d') {
    return (
      <>
        {slider('fretboardTilt', 'Fretboard tilt', CONTROL_TOOLTIPS.fretboardTilt, control('fretboardTilt', 1), -2, 2, 0.05)}
        {slider('fretSpan', 'Fret span', CONTROL_TOOLTIPS.fretSpanGlyph, control('fretSpan', 12), 5, 24, 1)}
        {slider('noteGlow', 'Note glow', CONTROL_TOOLTIPS.noteGlow, control('noteGlow', 1), 0, 3, 0.05)}
        {slider('spectrumHeight', 'Spectrum height', CONTROL_TOOLTIPS.spectrumHeight, control('spectrumHeight', 1), 0.2, 3, 0.05)}
      </>
    );
  }

  if (layer.mode === 'stringResonator3d') {
    return (
      <>
        {slider('stringCount', 'Strings', CONTROL_TOOLTIPS.stringCount, control('stringCount', 6), 1, 6, 1)}
        {slider('resonanceDecay', 'Decay', CONTROL_TOOLTIPS.resonanceDecay, control('resonanceDecay', 1), 0.25, 3, 0.05)}
        {slider('waveDepth', 'Wave depth', CONTROL_TOOLTIPS.waveDepth, control('waveDepth', 1), 0.1, 3, 0.05)}
        {slider('bendSensitivity', 'Bend sensitivity', CONTROL_TOOLTIPS.bendSensitivity, control('bendSensitivity', 1), 0, 3, 0.05)}
      </>
    );
  }

  return (
    <>
      {slider('shardCount', 'Shard count', CONTROL_TOOLTIPS.shardCount, control('shardCount', 1), 0.2, 1, 0.05)}
      {slider('scatter', 'Scatter', CONTROL_TOOLTIPS.scatter, control('scatter', 1), 0.2, 3, 0.05)}
      {slider('spin', 'Spin', CONTROL_TOOLTIPS.spinShard, control('spin', 1), 0, 3, 0.05)}
      {slider('fracture', 'Fracture', CONTROL_TOOLTIPS.fracture, control('fracture', 1), 0.2, 3, 0.05)}
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
  midi,
  onChange
}: {
  label: string;
  tooltip?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  midi?: SliderMidiProps;
  onChange: (value: number) => void;
}) {
  return (
    <div className="layer-slider">
      <label>
        <ControlLabel tooltip={tooltip} value={value.toFixed(step < 0.01 ? 3 : 2)}>
          {label}
        </ControlLabel>
      </label>
      {midi ? (
        <div className="midi-slider-row">
          <button type="button" className={midi.learning ? 'active' : 'secondary'} disabled={midi.disabled} onClick={midi.onLearn}>
            {midi.learning ? 'Learning' : 'Learn'}
          </button>
          {midi.mapping ? (
            <button type="button" className="secondary" onClick={midi.onForget}>
              Forget
            </button>
          ) : null}
          <span title={midi.mapping ? formatMidiSource(midi.mapping.source) : undefined}>
            {midi.mapping ? formatMidiSource(midi.mapping.source) : 'No MIDI'}
          </span>
        </div>
      ) : null}
      <input type="range" min={min} max={max} step={step} value={value} onInput={(event) => onChange(Number(event.currentTarget.value))} />
    </div>
  );
}

function ControlLabel({ children, tooltip, value }: { children: ReactNode; tooltip?: string; value?: ReactNode }) {
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties | null>(null);
  const showTooltip = Boolean(tooltip && tooltipStyle);

  function updateTooltipPosition() {
    const label = labelRef.current;
    if (!label) {
      return;
    }
    const rect = label.getBoundingClientRect();
    const width = Math.min(420, Math.max(280, window.innerWidth - 36));
    const left = Math.min(Math.max(18, rect.left), Math.max(18, window.innerWidth - width - 18));
    const top = rect.bottom + 8;
    setTooltipStyle({
      left,
      top,
      width,
      maxHeight: Math.max(160, window.innerHeight - top - 18)
    });
  }

  useEffect(() => {
    if (!showTooltip) {
      return;
    }
    const syncPosition = () => updateTooltipPosition();
    window.addEventListener('resize', syncPosition);
    window.addEventListener('scroll', syncPosition, true);
    return () => {
      window.removeEventListener('resize', syncPosition);
      window.removeEventListener('scroll', syncPosition, true);
    };
  }, [showTooltip]);

  return (
    <span
      ref={labelRef}
      className={`control-label${tooltip ? ' has-tooltip' : ''}`}
      tabIndex={tooltip ? 0 : undefined}
      onMouseEnter={tooltip ? updateTooltipPosition : undefined}
      onMouseLeave={tooltip ? () => setTooltipStyle(null) : undefined}
      onFocus={tooltip ? updateTooltipPosition : undefined}
      onBlur={tooltip ? () => setTooltipStyle(null) : undefined}
    >
      <span className="control-label-row">
        <span className="control-label-name">{children}</span>
        {value !== undefined ? <span className="control-label-value">{value}</span> : null}
      </span>
      {showTooltip
        ? createPortal(
            <span className="control-tooltip control-tooltip-portal" role="tooltip" style={tooltipStyle ?? undefined}>
              {tooltip}
            </span>,
            document.body
          )
        : null}
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
    sideScroller2d: { scrollSpeed: 1.25, laneGain: 1.25, historyFade: 0.014, eventAccent: 1.4 },
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
  } else if (mode === 'raindrops2d') {
    next.motionAmount = Number(next.motionAmount ?? 1);
    next.scaleAmount = Number(next.scaleAmount ?? 1);
    next.colorAmount = 0;
  } else if (mode === 'techniqueMap2d') {
    next.motionAmount = Number(next.scrollSpeed ?? 1);
    next.scaleAmount = Number(next.laneGain ?? 1);
    next.colorAmount = Number(next.eventAccent ?? 1);
  } else if (mode === 'sideScroller2d') {
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

function createMidiRuntime(mapping: MidiMapping, currentValue: number | null): MidiRuntimeState {
  return {
    pickupArmed: true,
    pickupValue: normalizeMidiControlValue(currentValue ?? mapping.range.min, mapping.range),
    lastNormalizedValue: null,
    lastCcValue: null,
    smoothedValue: currentValue,
    targetValue: null,
    lastAppliedValue: currentValue
  };
}

function midiPickupReached(runtime: MidiRuntimeState, range: MidiMappingRange, normalizedValue: number): boolean {
  const tolerance = Math.max(0.004, (range.step / Math.max(0.000001, range.max - range.min)) * 0.5);
  if (Math.abs(normalizedValue - runtime.pickupValue) <= tolerance) {
    return true;
  }
  if (runtime.lastNormalizedValue === null) {
    return false;
  }
  return (runtime.lastNormalizedValue - runtime.pickupValue) * (normalizedValue - runtime.pickupValue) <= 0;
}

function scaleMidiValue(normalizedValue: number, range: MidiMappingRange): number {
  return range.min + Math.max(0, Math.min(1, normalizedValue)) * (range.max - range.min);
}

function normalizeMidiControlValue(value: number, range: MidiMappingRange): number {
  return Math.max(0, Math.min(1, (value - range.min) / Math.max(0.000001, range.max - range.min)));
}

function quantizeMidiValue(value: number, range: MidiMappingRange): number {
  const clamped = Math.max(range.min, Math.min(range.max, value));
  if (range.step <= 0) {
    return clamped;
  }
  const snapped = range.min + Math.round((clamped - range.min) / range.step) * range.step;
  const decimals = getStepDecimals(range.step);
  return Number(Math.max(range.min, Math.min(range.max, snapped)).toFixed(decimals));
}

function getStepDecimals(step: number): number {
  const text = String(step);
  const dotIndex = text.indexOf('.');
  return dotIndex >= 0 ? text.length - dotIndex - 1 : 0;
}

function channelMatches(mappingChannel: MidiChannel, incomingChannel: number): boolean {
  return mappingChannel === 'omni' || mappingChannel === incomingChannel;
}

function midiSourcesOverlap(left: MidiMappingSource, right: MidiMappingSource): boolean {
  if (left.inputId !== right.inputId || left.cc !== right.cc) {
    return false;
  }
  return left.channel === 'omni' || right.channel === 'omni' || left.channel === right.channel;
}

function sameMidiTarget(left: MidiMappingTarget, right: MidiMappingTarget): boolean {
  return left.layerId === right.layerId && left.control === right.control;
}

function formatMidiSource(source: MidiMappingSource): string {
  const channel = source.channel === 'omni' ? 'Omni' : `Ch ${source.channel}`;
  return `${source.inputName}, ${channel}, CC ${source.cc}`;
}

function formatMidiInputName(input: MIDIInput): string {
  return input.name || input.manufacturer || input.id || 'MIDI input';
}

function formatMidiAccessError(error: unknown): string {
  if (error instanceof DOMException) {
    return `${error.name}: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'MIDI access was denied.';
}

function formatMidiTarget(target: MidiMappingTarget, layers: VisualLayer[]): string {
  const layer = layers.find((candidate) => candidate.id === target.layerId);
  return `${layer?.name ?? 'Missing layer'} ${formatControlKey(target.control)}`;
}

function formatControlKey(key: keyof VisualLayerControls): string {
  return String(key)
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function cloneMidiMappings(mappings: MidiMapping[]): MidiMapping[] {
  return mappings.map((mapping) => ({
    ...mapping,
    source: { ...mapping.source },
    target: { ...mapping.target },
    range: { ...mapping.range }
  }));
}

function normalizeMidiMappings(mappings: MidiMapping[] | undefined, layerIds: Set<string>): MidiMapping[] {
  if (!Array.isArray(mappings)) {
    return [];
  }
  return mappings
    .map((mapping) => normalizeMidiMapping(mapping, layerIds))
    .filter(Boolean) as MidiMapping[];
}

function normalizeMidiMapping(mapping: MidiMapping, layerIds: Set<string>): MidiMapping | null {
  if (!mapping || !mapping.source || !mapping.target || !mapping.range || !layerIds.has(mapping.target.layerId)) {
    return null;
  }
  const channel = mapping.source.channel === 'omni' ? 'omni' : clampInteger(mapping.source.channel, 1, 16, 1);
  const cc = clampInteger(mapping.source.cc, 0, 127, 0);
  const min = Number(mapping.range.min);
  const max = Number(mapping.range.max);
  const step = Number(mapping.range.step);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || max <= min || step <= 0) {
    return null;
  }
  return {
    id: typeof mapping.id === 'string' ? mapping.id : createId(),
    source: {
      inputId: typeof mapping.source.inputId === 'string' ? mapping.source.inputId : '',
      inputName: typeof mapping.source.inputName === 'string' ? mapping.source.inputName : 'MIDI input',
      channel,
      cc
    },
    target: {
      layerId: mapping.target.layerId,
      control: mapping.target.control
    },
    range: { min, max, step }
  };
}

function getLayerControlValueFromLayers(layers: VisualLayer[], target: MidiMappingTarget): number | null {
  const layer = layers.find((candidate) => candidate.id === target.layerId);
  const value = layer?.controls[target.control];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
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
    mode: stored.mode === 'playback' ? 'playback' : DEFAULT_START_CONFIG.mode,
    playbackItemId: typeof stored.playbackItemId === 'string' ? stored.playbackItemId : undefined,
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
    .map((preset) => {
      const layers = Array.isArray(preset.layers) ? (preset.layers.map(normalizeLayer).filter(Boolean) as VisualLayer[]) : [];
      return {
        id: typeof preset.id === 'string' ? preset.id : createId(),
        name: typeof preset.name === 'string' ? preset.name : 'Preset',
        layers,
        midiMappings: normalizeMidiMappings(preset.midiMappings, new Set(layers.map((layer) => layer.id))),
        createdAt: typeof preset.createdAt === 'number' ? preset.createdAt : Date.now()
      };
    })
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

function stopSignalAnalysisPolling(ref: { current: number | null }) {
  if (ref.current !== null) {
    window.clearInterval(ref.current);
    ref.current = null;
  }
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, durationMs / 1000);
  if (totalSeconds < 10) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${Math.round(totalSeconds)}s`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMetricValue(value: number): string {
  if (Math.abs(value) >= 100) {
    return value.toFixed(0);
  }
  if (Math.abs(value) >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(3);
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

function DspSidebar({
  features,
  minimized,
  onToggle
}: {
  features: ReturnType<typeof useAudioFeatures>['latest'];
  minimized: boolean;
  onToggle: () => void;
}) {
  const voicing = Array.isArray(features.voicing) ? features.voicing : [];
  const chroma = Array.isArray(features.chroma) ? features.chroma : [];
  const logSpectrum = Array.isArray(features.logSpectrum) ? features.logSpectrum : [];
  const events = Array.isArray(features.guitarEvents) ? features.guitarEvents : [];
  const voicingConfidence = voicing.length
    ? voicing.reduce((sum, candidate) => sum + candidate.confidence, 0) / voicing.length
    : 0;
  const strongestVoice = voicing.reduce((strongest, candidate) => Math.max(strongest, candidate.confidence), 0);
  const eventStrength = events.reduce((strongest, event) => Math.max(strongest, event.strength), 0);
  const chromaPeak = chroma.reduce((strongest, value) => Math.max(strongest, value), 0);
  const logSpectrumAverage = average(logSpectrum);
  const position = typeof features.stringNumber === 'number' && typeof features.fretNumber === 'number' ? `S${features.stringNumber} F${features.fretNumber}` : '--';

  return (
    <section className="dsp-sidebar">
      <RailHeader
        kicker="DSP inputs"
        title={minimized ? undefined : 'Signal status'}
        minimized={minimized}
        onToggle={onToggle}
      />
      {!minimized ? (
        <>
      <div className="dsp-meter-column">
        <Meter label="RMS" value={features.rms} />
        <Meter label="Peak" value={features.peak} alert={features.clipping} />
        <Meter label="Low" value={features.low} />
        <Meter label="Mid" value={features.mid} />
        <Meter label="High" value={features.high} />
        <Meter label="Centroid" value={features.spectralCentroid} />
        <Meter label="Pitch Hz" value={features.pitchConfidence} note={features.pitchHz ? `${features.pitchHz.toFixed(1)} Hz` : '--'} />
        <Meter label="Pitch" value={features.pitchConfidence} note={features.noteName ?? '--'} />
        <Meter label="Stable" value={features.noteStability} />
        <Meter label="Onset" value={features.onset} pulse={features.onset > 0.3} />
        <Meter label="Gate" value={features.gate ? 1 : 0} note={features.gate ? 'Open' : 'Idle'} pulse={features.gate} />
        <Meter label="Clip" value={features.clipping ? 1 : 0} note={features.clipping ? 'Clip' : 'OK'} alert={features.clipping} />
        <Meter label="Chroma" value={chromaPeak} note={`${activeCount(chroma, 0.16)}/12`} />
        <Meter label="Pos" value={features.pitchConfidence} note={position} />
        <Meter label="Voice" value={voicingConfidence} />
        <Meter label="Flux" value={features.spectralFlux} />
        <Meter label="Rolloff" value={features.spectralRolloff} />
        <Meter label="Flat" value={features.spectralFlatness} />
        <Meter label="Zero X" value={features.zeroCrossingRate} />
        <Meter label="Bright" value={features.brightness} />
        <Meter label="Noise" value={features.noisiness} />
        <Meter label="Attack" value={features.attack} pulse={features.attack > 0.3} />
        <Meter label="Decay" value={features.decay} />
        <Meter label="Pick" value={features.pickNoise} />
        <Meter label="Mute" value={features.muteAmount} />
        <Meter label="Harm" value={features.harmonicRatio} />
        <Meter label="Bend" value={Math.min(1, Math.abs(features.bendCents) / 180)} note={`${features.bendCents >= 0 ? '+' : ''}${features.bendCents.toFixed(0)}c`} />
        <Meter label="Vib" value={features.vibratoDepth} />
        <Meter label="Vib Rate" value={features.vibratoRate} />
        <Meter label="Harm Dens" value={features.harmonicDensity} />
        <Meter label="Chord Root" value={features.chordConfidence} note={features.chordRoot ?? '--'} />
        <Meter label="Chord Qual" value={features.chordConfidence} note={features.chordQuality ?? '--'} />
        <Meter label="Chord Name" value={features.chordConfidence} note={features.chordName ?? '--'} />
        <Meter label="Chord Conf" value={features.chordConfidence} />
        <Meter label="Spectrum" value={logSpectrumAverage} note={`${logSpectrum.length} bins`} />
        <Meter label="Contrast" value={features.spectralContrast} />
        <Meter label="Technique" value={features.guitarTechniqueConfidence} note={(features.guitarTechnique ?? 'idle').replace('_', ' ')} />
        <Meter label="Tech Conf" value={features.guitarTechniqueConfidence} />
        <Meter label="Voicing" value={strongestVoice} note={`${voicing.length} notes`} />
        <Meter label="Events" value={eventStrength} note={`${events.length} recent`} pulse={eventStrength > 0.4} />
      </div>
      <FeatureDetails features={features} voicingConfidence={voicingConfidence} position={position} />
        </>
      ) : null}
    </section>
  );
}

function FeatureDetails({
  features,
  voicingConfidence,
  position
}: {
  features: ReturnType<typeof useAudioFeatures>['latest'];
  voicingConfidence: number;
  position: string;
}) {
  const chord = features.chordName ?? '--';
  const logSpectrum = Array.isArray(features.logSpectrum) ? features.logSpectrum : [];
  const technique = features.guitarTechnique ?? 'idle';
  return (
    <div className="feature-details">
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
    </div>
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

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function activeCount(values: number[], threshold: number): number {
  return values.reduce((count, value) => count + (value > threshold ? 1 : 0), 0);
}

function Meter({ label, value, note, alert, pulse }: { label: DspMeterLabel; value: number; note?: string; alert?: boolean; pulse?: boolean }) {
  return (
    <div className={`meter ${alert ? 'alert' : ''} ${pulse ? 'pulse' : ''}`}>
      <div className="meter-label">
        <ControlLabel tooltip={DSP_METER_TOOLTIPS[label]}>{label}</ControlLabel>
        <strong>{note ?? Math.round(value * 100)}</strong>
      </div>
      <div className="meter-track">
        <div style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
      </div>
    </div>
  );
}

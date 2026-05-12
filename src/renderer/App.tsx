import { useEffect, useMemo, useRef, useState } from 'react';
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
import type { VisualRecordingResult, VisualSynthHandle } from './VisualSynth';

const INPUT_GAIN_MIN = 0.2;
const INPUT_GAIN_MAX = 10;
const GATE_THRESHOLD_MIN = 0.005;
const GATE_THRESHOLD_MAX = 0.95;
const GATE_THRESHOLD_STEP = 0.005;
const LAYER_STORAGE_KEY = 'guitar-art.visualLayers.v1';
const PRESET_STORAGE_KEY = 'guitar-art.visualLayerPresets.v1';
const A4_HZ = 440;
const A4_MIDI = 69;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const MODE_LABELS: Record<VisualLayerMode, string> = {
  trails2d: '2D Trails',
  lineArt2d: '2D Line Art',
  forms3d: '3D Forms',
  spectralField3d: '3D Spectral Field',
  chromaConstellation3d: '3D Chroma Constellation'
};

const MODE_KIND: Record<VisualLayerMode, VisualLayerKind> = {
  trails2d: '2d',
  lineArt2d: '2d',
  forms3d: '3d',
  spectralField3d: '3d',
  chromaConstellation3d: '3d'
};

type TunerReading = {
  active: boolean;
  noteName: string;
  cents: number;
  targetHz: number;
  pitchHz: number | null;
};

export function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [config, setConfig] = useState<AudioStartConfig>(DEFAULT_START_CONFIG);
  const [layers, setLayers] = useState<VisualLayer[]>(loadLayers);
  const [presets, setPresets] = useState<VisualLayerPreset[]>(loadPresets);
  const [presetName, setPresetName] = useState('New preset');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [recording, setRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState('Ready to record');
  const [status, setStatus] = useState<AudioStatus>({
    running: false,
    mode: 'simulator',
    nativeAvailable: false,
    message: 'Starting.'
  });
  const { latest, latestRef } = useAudioFeatures();
  const visualSynthRef = useRef<VisualSynthHandle | null>(null);
  const audio = getAudioClient();
  const art = getArtClient();

  useEffect(() => {
    audio.listDevices().then(setDevices).catch(() => setDevices([]));
    const off = audio.onStatus(setStatus);
    audio.start(DEFAULT_START_CONFIG).catch(() => undefined);
    return () => {
      off();
    };
  }, [audio]);

  useEffect(() => {
    localStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify(layers));
  }, [layers]);

  useEffect(() => {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
  }, [presets]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === config.deviceId),
    [devices, config.deviceId]
  );
  const channelCount = selectedDevice?.inputChannels ?? 2;

  async function start(mode: AudioMode = config.mode) {
    const next = { ...config, mode };
    setConfig(next);
    await audio.start(next);
  }

  async function stop() {
    await audio.stop();
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
      controls: {
        ...layer.controls,
        [key]: value
      }
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

  function startArtRecording() {
    visualSynthRef.current?.startRecording();
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
      const exportResult = await art.exportPng({
        dataUrl: result.dataUrl,
        suggestedName: createRecordingFileName(result)
      });
      setRecordingStatus(exportResult.canceled ? 'Export canceled' : 'PNG exported');
    } catch {
      setRecordingStatus('Export failed');
    }
  }

  return (
    <div className="app-shell">
      <aside className="control-rail">
        <TunerPanel features={latest} />

        <section className="control-group">
          <label>Input source</label>
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
          <label>USB input</label>
          <select
            value={config.deviceId ?? ''}
            onChange={(event) => setConfig((prev) => ({ ...prev, deviceId: event.target.value || undefined }))}
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
          <label>Channel</label>
          <select
            value={config.channelIndex}
            onChange={(event) => setConfig((prev) => ({ ...prev, channelIndex: Number(event.target.value) }))}
          >
            {Array.from({ length: channelCount }, (_, index) => (
              <option key={index} value={index}>
                Input {index + 1}
              </option>
            ))}
          </select>
          <label>Buffer</label>
          <select
            value={config.bufferSize}
            onChange={(event) =>
              setConfig((prev) => ({ ...prev, bufferSize: Number(event.target.value) as 128 | 256 | 512 }))
            }
          >
            <option value={128}>128</option>
            <option value={256}>256</option>
            <option value={512}>512</option>
          </select>
        </section>

        <section className="control-group">
          <label>
            Input gain {formatGainDb(config.inputGain)} ({config.inputGain.toFixed(2)}x)
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
            Gate {Math.round(config.gateThreshold * 100)}% ({config.gateThreshold.toFixed(3)})
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

        <section className="record-panel">
          <label>Art capture</label>
          <div className="record-actions">
            <button onClick={startArtRecording} disabled={recording}>
              Record
            </button>
            <button className="secondary" onClick={stopArtRecording} disabled={!recording}>
              Stop
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
          <div className="layer-add-row">
            <button onClick={() => addLayer('2d')}>+ 2D</button>
            <button onClick={() => addLayer('3d')}>+ 3D</button>
          </div>
        </section>

        <section className="preset-panel">
          <label>Presets</label>
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
      </aside>

      <main className="viewport">
        <VisualSynth ref={visualSynthRef} featuresRef={latestRef} layers={layers} />
        <DiagnosticsPanel features={latest} />
        <MeterStrip features={latest} />
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
          On
        </label>
      </div>

      <div className="layer-controls">
        <label>Mode</label>
        <select
          value={layer.mode}
          onChange={(event) =>
            onUpdate(layer.id, (prev) => ({
              ...prev,
              mode: event.target.value as VisualLayerMode,
              name: MODE_LABELS[event.target.value as VisualLayerMode]
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

      <LayerSlider label="Sensitivity" value={layer.controls.sensitivity} min={0.1} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'sensitivity', value)} />
      <LayerSlider label="Smoothing" value={layer.controls.smoothing} min={0} max={0.95} step={0.01} onChange={(value) => onUpdateControl(layer.id, 'smoothing', value)} />
      <LayerSlider label="Gate" value={layer.controls.gateThreshold} min={0} max={0.5} step={0.005} onChange={(value) => onUpdateControl(layer.id, 'gateThreshold', value)} />
      <LayerSlider label="Motion" value={layer.controls.motionAmount} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'motionAmount', value)} />
      <LayerSlider label="Scale" value={layer.controls.scaleAmount} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'scaleAmount', value)} />
      <LayerSlider label="Color" value={layer.controls.colorAmount} min={0} max={3} step={0.05} onChange={(value) => onUpdateControl(layer.id, 'colorAmount', value)} />
      <LayerSlider label="Opacity" value={layer.controls.opacity} min={0} max={1} step={0.01} onChange={(value) => onUpdateControl(layer.id, 'opacity', value)} />

      <label className="switch-row">
        <input
          type="checkbox"
          checked={layer.controls.requiresGate}
          onChange={(event) => onUpdateControl(layer.id, 'requiresGate', event.target.checked)}
        />
        Requires gate
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

function LayerSlider({
  label,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="layer-slider">
      <label>
        {label} <span>{value.toFixed(step < 0.01 ? 3 : 2)}</span>
      </label>
      <input type="range" min={min} max={max} step={step} value={value} onInput={(event) => onChange(Number(event.currentTarget.value))} />
    </div>
  );
}

function createLayer(mode: VisualLayerMode, index: number): VisualLayer {
  return {
    id: createId(),
    name: MODE_LABELS[mode],
    kind: MODE_KIND[mode],
    mode,
    enabled: true,
    controls: {
      ...DEFAULT_LAYER_CONTROLS,
      opacity: mode.endsWith('3d') ? 0.95 : 0.78,
      requiresGate: mode === 'forms3d'
    }
  };
}

function loadLayers(): VisualLayer[] {
  const stored = readJson<VisualLayer[]>(LAYER_STORAGE_KEY);
  if (!Array.isArray(stored)) {
    return cloneLayers(DEFAULT_VISUAL_LAYERS);
  }
  const layers = stored.map(normalizeLayer).filter(Boolean) as VisualLayer[];
  return layers.length > 0 ? layers : cloneLayers(DEFAULT_VISUAL_LAYERS);
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
  return {
    id: typeof layer.id === 'string' ? layer.id : createId(),
    name: typeof layer.name === 'string' ? layer.name : MODE_LABELS[layer.mode],
    kind: MODE_KIND[layer.mode],
    mode: layer.mode,
    enabled: typeof layer.enabled === 'boolean' ? layer.enabled : true,
    controls: {
      ...DEFAULT_LAYER_CONTROLS,
      ...(layer.controls ?? {})
    }
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
  return (
    <section className="diagnostics-panel">
      <div className="diagnostics-header">
        <span>Guitar data</span>
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
      <div className="diagnostic-grid">
        <DiagnosticStat label="Flux" value={features.spectralFlux} />
        <DiagnosticStat label="Flat" value={features.spectralFlatness} />
        <DiagnosticStat label="Noise" value={features.noisiness} />
        <DiagnosticStat label="Bright" value={features.brightness} />
        <DiagnosticStat label="Bend" value={features.bendCents} suffix="c" signed />
        <DiagnosticStat label="Vib" value={features.vibratoDepth} />
      </div>
    </section>
  );
}

function DiagnosticStat({
  label,
  value,
  suffix = '',
  signed = false
}: {
  label: string;
  value: number;
  suffix?: string;
  signed?: boolean;
}) {
  const text = signed ? `${value >= 0 ? '+' : ''}${value.toFixed(0)}${suffix}` : `${Math.round(clampPercent(value))}`;
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

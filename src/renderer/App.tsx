import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioDevice, AudioMode, AudioParamsUpdate, AudioStartConfig, AudioStatus, LayerState } from '../shared/audio';
import { DEFAULT_START_CONFIG } from '../shared/audio';
import { getAudioClient } from './audioClient';
import { useAudioFeatures } from './useAudioFeatures';
import { VisualSynth } from './VisualSynth';

const INPUT_GAIN_MIN = 0.2;
const INPUT_GAIN_MAX = 10;

export function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [config, setConfig] = useState<AudioStartConfig>(DEFAULT_START_CONFIG);
  const [layers, setLayers] = useState<LayerState>({ draw2d: true, draw3d: true });
  const [status, setStatus] = useState<AudioStatus>({
    running: false,
    mode: 'simulator',
    nativeAvailable: false,
    message: 'Starting.'
  });
  const { latest, latestRef } = useAudioFeatures();
  const audio = getAudioClient();
  const pendingParamsRef = useRef<AudioParamsUpdate>({});
  const paramsFrameRef = useRef<number | null>(null);

  const pushLiveParams = useCallback(
    (params: AudioParamsUpdate) => {
      pendingParamsRef.current = { ...pendingParamsRef.current, ...params };

      if (paramsFrameRef.current !== null) {
        return;
      }

      paramsFrameRef.current = window.requestAnimationFrame(() => {
        const next = pendingParamsRef.current;
        pendingParamsRef.current = {};
        paramsFrameRef.current = null;
        void audio.setParams(next).catch(() => undefined);
      });
    },
    [audio]
  );

  useEffect(() => {
    audio.listDevices().then(setDevices).catch(() => setDevices([]));
    const off = audio.onStatus(setStatus);
    audio.start(DEFAULT_START_CONFIG).catch(() => undefined);
    return () => {
      off();
    };
  }, [audio]);

  useEffect(() => {
    return () => {
      if (paramsFrameRef.current !== null) {
        window.cancelAnimationFrame(paramsFrameRef.current);
      }
    };
  }, []);

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

  return (
    <div className="app-shell">
      <aside className="control-rail">
        <div className="brand-block">
          <div className="brand-title">Guitar Art</div>
          <div className="status-line">{status.message}</div>
        </div>

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
            onChange={(event) => {
              const inputGain = Number(event.target.value);
              setConfig((prev) => ({ ...prev, inputGain }));
              pushLiveParams({ inputGain });
            }}
          />
          <label>Gate {config.gateThreshold.toFixed(3)}</label>
          <input
            type="range"
            min="0.005"
            max="0.12"
            step="0.005"
            value={config.gateThreshold}
            onChange={(event) => {
              const gateThreshold = Number(event.target.value);
              setConfig((prev) => ({ ...prev, gateThreshold }));
              pushLiveParams({ gateThreshold });
            }}
          />
        </section>

        <section className="control-group">
          <label>Drawing layers</label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={layers.draw2d}
              onChange={(event) => setLayers((prev) => ({ ...prev, draw2d: event.target.checked }))}
            />
            2D trails
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={layers.draw3d}
              onChange={(event) => setLayers((prev) => ({ ...prev, draw3d: event.target.checked }))}
            />
            3D forms
          </label>
        </section>

        <section className="transport">
          <button onClick={() => start(config.mode)}>{status.running ? 'Restart' : 'Start'}</button>
          <button className="secondary" onClick={stop}>
            Stop
          </button>
        </section>
      </aside>

      <main className="viewport">
        <VisualSynth featuresRef={latestRef} layers={layers} />
        <MeterStrip features={latest} status={status} />
      </main>
    </div>
  );
}

function formatGainDb(gain: number): string {
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function MeterStrip({ features, status }: { features: ReturnType<typeof useAudioFeatures>['latest']; status: AudioStatus }) {
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
      <div className={`gate-pill ${features.gate ? 'open' : ''}`}>{features.gate ? 'Gate open' : 'Idle'}</div>
      <div className="engine-pill">{status.nativeAvailable ? 'Native ready' : 'Simulator fallback'}</div>
    </div>
  );
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

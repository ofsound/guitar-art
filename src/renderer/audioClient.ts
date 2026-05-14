import type {
  AnalysisRecordingWaveform,
  AudioDevice,
  AudioFeatures,
  AudioLibraryItem,
  AudioLibraryRecordResult,
  AudioMode,
  AudioParamsUpdate,
  AudioStartConfig,
  AudioStatus,
  MediaExportRequest,
  MediaExportResult,
  PngExportRequest,
  PngExportResult,
  RawAudioRecording
} from '../shared/audio';
import { DEFAULT_FEATURES, DEFAULT_START_CONFIG } from '../shared/audio';
import { PlaybackFeatureEngine } from './playbackFeatureEngine';
import type { PlaybackTransportState } from './playbackFeatureEngine';

type AudioClient = Window['guitarArt']['audio'];
type LibraryClient = Window['guitarArt']['library'];
type ArtClient = Window['guitarArt']['art'];

export type PlaybackClient = {
  load: (item: AudioLibraryItem | null, params?: Pick<AudioStartConfig, 'inputGain' | 'gateThreshold'>) => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  reset: () => void;
  stop: () => void;
  getState: () => PlaybackTransportState;
  subscribe: (listener: (state: PlaybackTransportState) => void) => () => void;
};

const fallbackStatusListeners = new Set<(status: AudioStatus) => void>();
const playbackEngine = new PlaybackFeatureEngine();
let wrappedAudioClient: AudioClient | null = null;
let currentMode: AudioMode = DEFAULT_START_CONFIG.mode;

export function getAudioClient(): AudioClient {
  if (!window.guitarArt?.audio) {
    return fallbackAudioClient;
  }
  wrappedAudioClient = wrappedAudioClient ?? createAudioClient(window.guitarArt.audio, getLibraryClient());
  return wrappedAudioClient;
}

export function getPlaybackClient(): PlaybackClient {
  return {
    load: async (item, params = DEFAULT_START_CONFIG) => {
      if (!item) {
        playbackEngine.stop();
        return;
      }
      await playbackEngine.load(item, {
        inputGain: params.inputGain,
        gateThreshold: params.gateThreshold
      });
    },
    play: () => playbackEngine.play(),
    pause: () => playbackEngine.pause(),
    reset: () => playbackEngine.reset(),
    stop: () => playbackEngine.stop(),
    getState: () => playbackEngine.getState(),
    subscribe: (listener) => playbackEngine.subscribe(listener)
  };
}

export function getLibraryClient(): LibraryClient {
  return window.guitarArt?.library ?? fallbackLibraryClient;
}

export function getArtClient(): ArtClient {
  return window.guitarArt?.art ?? fallbackArtClient;
}

const fallbackAudioClient: AudioClient = {
  listDevices: async (): Promise<AudioDevice[]> => [],
  start: async (config: AudioStartConfig): Promise<void> => {
    currentMode = config.mode;
    if (config.mode === 'playback') {
      emitFallbackStatus('Playback requires the Electron preload library bridge.');
      return;
    }
    emitFallbackStatus('Live input requires the Electron preload audio bridge.');
    throw new Error('Audio bridge unavailable.');
  },
  stop: async (): Promise<void> => {
    playbackEngine.reset();
    emitFallbackStatus('Audio stopped.');
  },
  setMode: async (mode: AudioMode): Promise<void> => {
    currentMode = mode;
    emitFallbackStatus(mode === 'playback' ? 'Playback selected.' : 'Live input selected.');
  },
  setParams: async (params: AudioParamsUpdate): Promise<void> => {
    playbackEngine.setParams(params);
  },
  getLatestFeatures: async (): Promise<AudioFeatures> => {
    return currentMode === 'playback' ? playbackEngine.getLatestFeatures() : DEFAULT_FEATURES;
  },
  startAnalysisRecording: async (): Promise<void> => {
    throw new Error('Native audio analysis recording is unavailable.');
  },
  getAnalysisRecordingWaveform: async (): Promise<AnalysisRecordingWaveform> => ({
    durationMs: 0,
    totalSamples: 0,
    waveform: []
  }),
  stopAnalysisRecording: async (): Promise<RawAudioRecording> => ({
    sampleRate: DEFAULT_START_CONFIG.sampleRate,
    samples: []
  }),
  onStatus: (listener: (status: AudioStatus) => void) => {
    fallbackStatusListeners.add(listener);
    listener(makeFallbackStatus('Audio bridge unavailable.'));
    return () => {
      fallbackStatusListeners.delete(listener);
    };
  }
};

const fallbackLibraryClient: LibraryClient = {
  list: async (): Promise<AudioLibraryItem[]> => [],
  import: async (): Promise<AudioLibraryItem[]> => [],
  delete: async (): Promise<void> => undefined,
  startRecording: async (): Promise<void> => {
    throw new Error('Native audio library recording is unavailable.');
  },
  getRecordingWaveform: async (): Promise<AnalysisRecordingWaveform> => ({
    durationMs: 0,
    totalSamples: 0,
    waveform: []
  }),
  stopRecording: async (): Promise<AudioLibraryRecordResult> => ({
    item: {
      id: 'fallback',
      name: 'Browser recording',
      fileName: 'browser-recording.wav',
      extension: 'wav',
      fileUrl: '',
      sizeBytes: 0,
      createdAt: Date.now(),
      source: 'recording'
    },
    recording: {
      sampleRate: DEFAULT_START_CONFIG.sampleRate,
      samples: []
    }
  })
};

const fallbackArtClient: ArtClient = {
  exportPng: async (request: PngExportRequest): Promise<PngExportResult> => {
    const anchor = document.createElement('a');
    anchor.href = request.dataUrl;
    anchor.download = request.suggestedName.endsWith('.png') ? request.suggestedName : `${request.suggestedName}.png`;
    anchor.click();
    return { canceled: false };
  },
  exportMedia: async (request: MediaExportRequest): Promise<MediaExportResult> => {
    const anchor = document.createElement('a');
    anchor.href = request.dataUrl;
    anchor.download = request.suggestedName.endsWith(`.${request.extension}`) ? request.suggestedName : `${request.suggestedName}.${request.extension}`;
    anchor.click();
    return { canceled: false };
  }
};

function emitFallbackStatus(message: string) {
  const status = makeFallbackStatus(message);
  fallbackStatusListeners.forEach((listener) => listener(status));
}

function makeFallbackStatus(message: string): AudioStatus {
  return {
    running: currentMode === 'playback' && playbackEngine.active,
    mode: currentMode,
    nativeAvailable: false,
    message
  };
}

function createAudioClient(base: AudioClient, library: LibraryClient): AudioClient {
  return {
    listDevices: () => base.listDevices(),
    start: async (config: AudioStartConfig): Promise<void> => {
      currentMode = config.mode;
      if (config.mode === 'playback') {
        const items = await library.list();
        const item = items.find((candidate) => candidate.id === config.playbackItemId) ?? items[0];
        if (!item) {
          throw new Error('Import or record a Playback library item first.');
        }
        await base.start({ ...config, mode: 'playback', playbackItemId: item.id });
        await playbackEngine.start(item, {
          inputGain: config.inputGain,
          gateThreshold: config.gateThreshold
        });
        return;
      }

      playbackEngine.reset();
      await base.start(config);
    },
    stop: async (): Promise<void> => {
      playbackEngine.reset();
      await base.stop();
    },
    setMode: async (mode: AudioMode): Promise<void> => {
      currentMode = mode;
      if (mode !== 'playback') {
        playbackEngine.reset();
      }
      await base.setMode(mode);
    },
    setParams: async (params: AudioParamsUpdate): Promise<void> => {
      playbackEngine.setParams(params);
      await base.setParams(params);
    },
    getLatestFeatures: async (): Promise<AudioFeatures> => {
      if (currentMode === 'playback') {
        return playbackEngine.getLatestFeatures();
      }
      return base.getLatestFeatures();
    },
    startAnalysisRecording: (config: AudioStartConfig) => base.startAnalysisRecording(config),
    getAnalysisRecordingWaveform: () => base.getAnalysisRecordingWaveform(),
    stopAnalysisRecording: () => base.stopAnalysisRecording(),
    onStatus: (listener: (status: AudioStatus) => void) => base.onStatus(listener)
  };
}

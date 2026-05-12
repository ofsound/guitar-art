import type {
  AudioDevice,
  AudioFeatures,
  AudioMode,
  AudioParamsUpdate,
  AudioStartConfig,
  AudioStatus,
  PngExportRequest,
  PngExportResult
} from '../shared/audio';

declare global {
  interface Window {
    guitarArt: {
      audio: {
        listDevices: () => Promise<AudioDevice[]>;
        start: (config: AudioStartConfig) => Promise<void>;
        stop: () => Promise<void>;
        setMode: (mode: AudioMode) => Promise<void>;
        setParams: (params: AudioParamsUpdate) => Promise<void>;
        getLatestFeatures: () => Promise<AudioFeatures>;
        onStatus: (listener: (status: AudioStatus) => void) => () => void;
      };
      art: {
        exportPng: (request: PngExportRequest) => Promise<PngExportResult>;
      };
    };
  }
}

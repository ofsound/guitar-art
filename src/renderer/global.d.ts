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
        startAnalysisRecording: (config: AudioStartConfig) => Promise<void>;
        getAnalysisRecordingWaveform: () => Promise<AnalysisRecordingWaveform>;
        stopAnalysisRecording: () => Promise<RawAudioRecording>;
        onStatus: (listener: (status: AudioStatus) => void) => () => void;
      };
      library: {
        list: () => Promise<AudioLibraryItem[]>;
        import: () => Promise<AudioLibraryItem[]>;
        delete: (id: string) => Promise<void>;
        startRecording: (config: AudioStartConfig) => Promise<void>;
        getRecordingWaveform: () => Promise<AnalysisRecordingWaveform>;
        stopRecording: (name: string) => Promise<AudioLibraryRecordResult>;
      };
      art: {
        exportPng: (request: PngExportRequest) => Promise<PngExportResult>;
        exportMedia: (request: MediaExportRequest) => Promise<MediaExportResult>;
      };
    };
  }
}

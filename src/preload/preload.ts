import { contextBridge, ipcRenderer } from 'electron';
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
import {
  ART_EXPORT_MEDIA,
  ART_EXPORT_PNG,
  AUDIO_GET_ANALYSIS_RECORDING_WAVEFORM,
  AUDIO_GET_LATEST_FEATURES,
  AUDIO_LIBRARY_DELETE,
  AUDIO_LIBRARY_GET_RECORDING_WAVEFORM,
  AUDIO_LIBRARY_IMPORT,
  AUDIO_LIBRARY_LIST,
  AUDIO_LIBRARY_START_RECORDING,
  AUDIO_LIBRARY_STOP_RECORDING,
  AUDIO_LIST_DEVICES,
  AUDIO_SET_PARAMS,
  AUDIO_SET_MODE,
  AUDIO_START,
  AUDIO_START_ANALYSIS_RECORDING,
  AUDIO_STATUS,
  AUDIO_STOP,
  AUDIO_STOP_ANALYSIS_RECORDING
} from '../shared/ipc';

const api = {
  audio: {
    listDevices: (): Promise<AudioDevice[]> => ipcRenderer.invoke(AUDIO_LIST_DEVICES),
    start: (config: AudioStartConfig): Promise<void> => ipcRenderer.invoke(AUDIO_START, config),
    stop: (): Promise<void> => ipcRenderer.invoke(AUDIO_STOP),
    setMode: (mode: AudioMode): Promise<void> => ipcRenderer.invoke(AUDIO_SET_MODE, mode),
    setParams: (params: AudioParamsUpdate): Promise<void> => ipcRenderer.invoke(AUDIO_SET_PARAMS, params),
    getLatestFeatures: (): Promise<AudioFeatures> => ipcRenderer.invoke(AUDIO_GET_LATEST_FEATURES),
    startAnalysisRecording: (config: AudioStartConfig): Promise<void> => ipcRenderer.invoke(AUDIO_START_ANALYSIS_RECORDING, config),
    getAnalysisRecordingWaveform: (): Promise<AnalysisRecordingWaveform> => ipcRenderer.invoke(AUDIO_GET_ANALYSIS_RECORDING_WAVEFORM),
    stopAnalysisRecording: (): Promise<RawAudioRecording> => ipcRenderer.invoke(AUDIO_STOP_ANALYSIS_RECORDING),
    onStatus: (listener: (status: AudioStatus) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, status: AudioStatus) => listener(status);
      ipcRenderer.on(AUDIO_STATUS, wrapped);
      return () => {
        ipcRenderer.off(AUDIO_STATUS, wrapped);
      };
    }
  },
  library: {
    list: (): Promise<AudioLibraryItem[]> => ipcRenderer.invoke(AUDIO_LIBRARY_LIST),
    import: (): Promise<AudioLibraryItem[]> => ipcRenderer.invoke(AUDIO_LIBRARY_IMPORT),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(AUDIO_LIBRARY_DELETE, id),
    startRecording: (config: AudioStartConfig): Promise<void> => ipcRenderer.invoke(AUDIO_LIBRARY_START_RECORDING, config),
    getRecordingWaveform: (): Promise<AnalysisRecordingWaveform> => ipcRenderer.invoke(AUDIO_LIBRARY_GET_RECORDING_WAVEFORM),
    stopRecording: (name: string): Promise<AudioLibraryRecordResult> => ipcRenderer.invoke(AUDIO_LIBRARY_STOP_RECORDING, name)
  },
  art: {
    exportPng: (request: PngExportRequest): Promise<PngExportResult> => ipcRenderer.invoke(ART_EXPORT_PNG, request),
    exportMedia: (request: MediaExportRequest): Promise<MediaExportResult> => ipcRenderer.invoke(ART_EXPORT_MEDIA, request)
  }
};

contextBridge.exposeInMainWorld('guitarArt', api);

declare global {
  interface Window {
    guitarArt: typeof api;
  }
}

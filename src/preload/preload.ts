import { contextBridge, ipcRenderer } from 'electron';
import type { AudioDevice, AudioFeatures, AudioMode, AudioStartConfig, AudioStatus } from '../shared/audio';
import {
  AUDIO_GET_LATEST_FEATURES,
  AUDIO_LIST_DEVICES,
  AUDIO_SET_MODE,
  AUDIO_START,
  AUDIO_STATUS,
  AUDIO_STOP
} from '../shared/ipc';

const api = {
  audio: {
    listDevices: (): Promise<AudioDevice[]> => ipcRenderer.invoke(AUDIO_LIST_DEVICES),
    start: (config: AudioStartConfig): Promise<void> => ipcRenderer.invoke(AUDIO_START, config),
    stop: (): Promise<void> => ipcRenderer.invoke(AUDIO_STOP),
    setMode: (mode: AudioMode): Promise<void> => ipcRenderer.invoke(AUDIO_SET_MODE, mode),
    getLatestFeatures: (): Promise<AudioFeatures> => ipcRenderer.invoke(AUDIO_GET_LATEST_FEATURES),
    onStatus: (listener: (status: AudioStatus) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, status: AudioStatus) => listener(status);
      ipcRenderer.on(AUDIO_STATUS, wrapped);
      return () => ipcRenderer.off(AUDIO_STATUS, wrapped);
    }
  }
};

contextBridge.exposeInMainWorld('guitarArt', api);

declare global {
  interface Window {
    guitarArt: typeof api;
  }
}

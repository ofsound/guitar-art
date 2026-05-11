import type { AudioDevice, AudioFeatures, AudioMode, AudioStartConfig, AudioStatus } from '../shared/audio';

declare global {
  interface Window {
    guitarArt: {
      audio: {
        listDevices: () => Promise<AudioDevice[]>;
        start: (config: AudioStartConfig) => Promise<void>;
        stop: () => Promise<void>;
        setMode: (mode: AudioMode) => Promise<void>;
        getLatestFeatures: () => Promise<AudioFeatures>;
        onStatus: (listener: (status: AudioStatus) => void) => () => void;
      };
    };
  }
}

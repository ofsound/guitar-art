import { app, BrowserWindow, ipcMain, systemPreferences } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import type { AudioMode, AudioParamsUpdate, AudioStartConfig } from '../shared/audio';
import {
  AUDIO_GET_LATEST_FEATURES,
  AUDIO_LIST_DEVICES,
  AUDIO_SET_PARAMS,
  AUDIO_SET_MODE,
  AUDIO_START,
  AUDIO_STATUS,
  AUDIO_STOP
} from '../shared/ipc';
import { AudioEngineHost } from './nativeAudio';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

if (started) {
  app.quit();
}

const audioHost = new AudioEngineHost();
let mainWindow: BrowserWindow | null = null;
let statusTimer: NodeJS.Timeout | null = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: 'Guitar Art',
    backgroundColor: '#090b0d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  statusTimer = setInterval(() => {
    mainWindow?.webContents.send(AUDIO_STATUS, audioHost.getStatus());
  }, 500);
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  registerAudioIpc();
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (statusTimer) {
    clearInterval(statusTimer);
  }
  audioHost.stop();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function registerAudioIpc() {
  ipcMain.handle(AUDIO_LIST_DEVICES, () => audioHost.listDevices());

  ipcMain.handle(AUDIO_START, (_event, config: AudioStartConfig) => {
    audioHost.start(config);
    mainWindow?.webContents.send(AUDIO_STATUS, audioHost.getStatus());
  });

  ipcMain.handle(AUDIO_STOP, () => {
    audioHost.stop();
    mainWindow?.webContents.send(AUDIO_STATUS, audioHost.getStatus());
  });

  ipcMain.handle(AUDIO_SET_MODE, (_event, mode: AudioMode) => {
    audioHost.setMode(mode);
    mainWindow?.webContents.send(AUDIO_STATUS, audioHost.getStatus());
  });

  ipcMain.handle(AUDIO_SET_PARAMS, (_event, params: AudioParamsUpdate) => {
    audioHost.setParams(params);
  });

  ipcMain.handle(AUDIO_GET_LATEST_FEATURES, () => audioHost.getLatestFeatures());
}

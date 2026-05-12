import { app, BrowserWindow, dialog, ipcMain, systemPreferences } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import type { AudioMode, AudioParamsUpdate, AudioStartConfig, PngExportRequest, PngExportResult } from '../shared/audio';
import {
  ART_EXPORT_PNG,
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
  registerArtIpc();
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

function registerArtIpc() {
  ipcMain.handle(ART_EXPORT_PNG, async (_event, request: PngExportRequest): Promise<PngExportResult> => {
    const buffer = pngDataUrlToBuffer(request.dataUrl);
    const defaultPath = ensurePngExtension(request.suggestedName || `guitar-art-${Date.now()}.png`);
    const options = {
      title: 'Export generated art',
      defaultPath,
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const filePath = ensurePngExtension(result.filePath);
    await writeFile(filePath, buffer);
    return { canceled: false, filePath };
  });
}

function pngDataUrlToBuffer(dataUrl: string): Buffer {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) {
    throw new Error('Expected PNG data URL.');
  }
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

function ensurePngExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase() === '.png' ? filePath : `${filePath}.png`;
}

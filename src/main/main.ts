import { app, BrowserWindow, dialog, ipcMain, session, systemPreferences } from 'electron';
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import started from 'electron-squirrel-startup';
import type {
  AnalysisRecordingWaveform,
  AudioLibraryItem,
  AudioLibraryRecordResult,
  AudioMode,
  AudioParamsUpdate,
  AudioStartConfig,
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
import { AudioEngineHost } from './nativeAudio';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

if (started) {
  app.quit();
}

const audioHost = new AudioEngineHost();
let mainWindow: BrowserWindow | null = null;
let statusTimer: NodeJS.Timeout | null = null;
let audioLibrary: AudioLibraryStore | null = null;
const MIDI_PERMISSIONS = new Set(['midi', 'midiSysex']);

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
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => MIDI_PERMISSIONS.has(permission));
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(MIDI_PERMISSIONS.has(permission));
  });

  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  registerAudioIpc();
  registerArtIpc();
  audioLibrary = new AudioLibraryStore();
  await audioLibrary.ready();
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

  ipcMain.handle(AUDIO_START_ANALYSIS_RECORDING, (_event, config: AudioStartConfig) => {
    audioHost.startAnalysisRecording(config);
  });

  ipcMain.handle(AUDIO_GET_ANALYSIS_RECORDING_WAVEFORM, (): AnalysisRecordingWaveform => audioHost.getAnalysisRecordingWaveform());

  ipcMain.handle(AUDIO_STOP_ANALYSIS_RECORDING, (): RawAudioRecording => audioHost.stopAnalysisRecording());

  ipcMain.handle(AUDIO_LIBRARY_LIST, async (): Promise<AudioLibraryItem[]> => {
    return getAudioLibrary().list();
  });

  ipcMain.handle(AUDIO_LIBRARY_IMPORT, async (): Promise<AudioLibraryItem[]> => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: 'Import audio to Playback library',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Audio files', extensions: ['mp3', 'wav', 'aif', 'aiff'] }]
        })
      : await dialog.showOpenDialog({
          title: 'Import audio to Playback library',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Audio files', extensions: ['mp3', 'wav', 'aif', 'aiff'] }]
        });

    if (result.canceled || result.filePaths.length === 0) {
      return getAudioLibrary().list();
    }

    return getAudioLibrary().importFiles(result.filePaths);
  });

  ipcMain.handle(AUDIO_LIBRARY_DELETE, async (_event, id: string): Promise<void> => {
    await getAudioLibrary().delete(id);
  });

  ipcMain.handle(AUDIO_LIBRARY_START_RECORDING, (_event, config: AudioStartConfig) => {
    audioHost.startLibraryRecording({ ...config, mode: 'live', deviceId: undefined });
  });

  ipcMain.handle(AUDIO_LIBRARY_GET_RECORDING_WAVEFORM, (): AnalysisRecordingWaveform => audioHost.getLibraryRecordingWaveform());

  ipcMain.handle(AUDIO_LIBRARY_STOP_RECORDING, async (_event, name: string): Promise<AudioLibraryRecordResult> => {
    const recording = audioHost.stopLibraryRecording();
    const item = await getAudioLibrary().addRecording(name, recording);
    return { item, recording };
  });
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

  ipcMain.handle(ART_EXPORT_MEDIA, async (_event, request: MediaExportRequest): Promise<MediaExportResult> => {
    const buffer = dataUrlToBuffer(request.dataUrl, request.mimeType);
    const defaultPath = ensureExtension(request.suggestedName || `guitar-art-${Date.now()}.${request.extension}`, request.extension);
    const options = {
      title: request.extension === 'webm' ? 'Export performance recording' : 'Export generated art',
      defaultPath,
      filters: [{ name: request.extension === 'webm' ? 'WebM video' : 'PNG image', extensions: [request.extension] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const filePath = ensureExtension(result.filePath, request.extension);
    await writeFile(filePath, buffer);
    return { canceled: false, filePath };
  });
}

function pngDataUrlToBuffer(dataUrl: string): Buffer {
  return dataUrlToBuffer(dataUrl, 'image/png');
}

function dataUrlToBuffer(dataUrl: string, mimeType: string): Buffer {
  const prefix = `data:${mimeType};base64,`;
  if (!dataUrl.startsWith(prefix)) {
    throw new Error(`Expected ${mimeType} data URL.`);
  }
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

function ensurePngExtension(filePath: string): string {
  return ensureExtension(filePath, 'png');
}

function ensureExtension(filePath: string, extension: string): string {
  return path.extname(filePath).toLowerCase() === `.${extension}` ? filePath : `${filePath}.${extension}`;
}

function getAudioLibrary(): AudioLibraryStore {
  if (!audioLibrary) {
    audioLibrary = new AudioLibraryStore();
  }
  return audioLibrary;
}

class AudioLibraryStore {
  private readonly dir = path.join(app.getPath('userData'), 'audio-library');
  private readonly manifestPath = path.join(this.dir, 'library.json');
  private items: AudioLibraryItem[] = [];
  private readyPromise: Promise<void>;

  constructor() {
    this.readyPromise = this.load();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async list(): Promise<AudioLibraryItem[]> {
    await this.ready();
    return this.items.map((item) => ({ ...item }));
  }

  async importFiles(filePaths: string[]): Promise<AudioLibraryItem[]> {
    await this.ready();
    for (const filePath of filePaths) {
      const extension = normalizeAudioExtension(path.extname(filePath));
      if (!extension) {
        continue;
      }
      const id = randomUUID();
      const fileName = `${id}.${extension}`;
      const destination = path.join(this.dir, fileName);
      await copyFile(filePath, destination);
      const info = await stat(destination);
      this.items.unshift({
        id,
        name: path.basename(filePath, path.extname(filePath)),
        fileName,
        extension,
        fileUrl: pathToFileURL(destination).toString(),
        sizeBytes: info.size,
        createdAt: Date.now(),
        source: 'import'
      });
    }
    await this.save();
    return this.list();
  }

  async addRecording(name: string, recording: RawAudioRecording): Promise<AudioLibraryItem> {
    await this.ready();
    const id = randomUUID();
    const fileName = `${id}.wav`;
    const filePath = path.join(this.dir, fileName);
    await writeFile(filePath, encodePcmWav(recording.samples, recording.sampleRate));
    const info = await stat(filePath);
    const item: AudioLibraryItem = {
      id,
      name: sanitizeLibraryName(name) || `Input recording ${new Date().toLocaleString()}`,
      fileName,
      extension: 'wav',
      fileUrl: pathToFileURL(filePath).toString(),
      sizeBytes: info.size,
      createdAt: Date.now(),
      durationMs: Math.round((recording.samples.length / recording.sampleRate) * 1000),
      source: 'recording'
    };
    this.items.unshift(item);
    await this.save();
    return { ...item };
  }

  async delete(id: string): Promise<void> {
    await this.ready();
    const item = this.items.find((candidate) => candidate.id === id);
    this.items = this.items.filter((candidate) => candidate.id !== id);
    if (item) {
      await unlink(path.join(this.dir, item.fileName)).catch(() => undefined);
    }
    await this.save();
  }

  private async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.manifestPath, 'utf8')) as unknown;
      this.items = Array.isArray(raw) ? raw.map((item) => normalizeLibraryItem(item, this.dir)).filter((item): item is AudioLibraryItem => Boolean(item)) : [];
    } catch {
      this.items = [];
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.manifestPath, JSON.stringify(this.items, null, 2));
  }
}

function normalizeLibraryItem(value: unknown, dir: string): AudioLibraryItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Partial<AudioLibraryItem>;
  const extension = normalizeAudioExtension(item.extension ?? path.extname(item.fileName ?? ''));
  if (!item.id || !item.fileName || !extension) {
    return null;
  }
  return {
    id: String(item.id),
    name: sanitizeLibraryName(item.name) || path.basename(item.fileName, path.extname(item.fileName)),
    fileName: String(item.fileName),
    extension,
    fileUrl: pathToFileURL(path.join(dir, String(item.fileName))).toString(),
    sizeBytes: Math.max(0, Number(item.sizeBytes) || 0),
    createdAt: Number(item.createdAt) || Date.now(),
    durationMs: Number.isFinite(item.durationMs) ? Number(item.durationMs) : undefined,
    source: item.source === 'recording' ? 'recording' : 'import'
  };
}

function normalizeAudioExtension(extension: string | undefined): AudioLibraryItem['extension'] | null {
  const value = (extension ?? '').replace(/^\./, '').toLowerCase();
  return value === 'mp3' || value === 'wav' || value === 'aif' || value === 'aiff' ? value : null;
}

function sanitizeLibraryName(name: unknown): string {
  return String(name ?? '').trim().replace(/[/:\\]/g, '-').slice(0, 80);
}

function encodePcmWav(samples: number[], sampleRate: number): Buffer {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, Number(samples[index]) || 0));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * bytesPerSample);
  }
  return buffer;
}

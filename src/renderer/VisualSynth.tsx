import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import type { AudioFeatures, VisualLayer } from '../shared/audio';

type Particle = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  hue: number;
};

type SeedPoint = {
  angle: number;
  radius: number;
  band: 0 | 1 | 2;
  drift: number;
};

type ShardSeed = {
  angle: number;
  radius: number;
  height: number;
  phase: number;
  techniqueBias: number;
};

type Raindrop = {
  x: number;
  y: number;
  strength: number;
  createdAt: number;
};

type LayerFrame = {
  rms: number;
  peak: number;
  low: number;
  mid: number;
  high: number;
  spectralCentroid: number;
  spectralFlux: number;
  brightness: number;
  noisiness: number;
  attack: number;
  vibratoDepth: number;
  vibratoRate: number;
  onset: number;
  noteStability: number;
  gateOpen: boolean;
  hue: number;
};

export type VisualRenderQuality = 'low' | 'medium' | 'high';

const TWO_D_QUALITY_LIMITS: Record<Exclude<VisualRenderQuality, 'high'>, { width: number; height: number }> = {
  low: { width: 854, height: 480 },
  medium: { width: 1280, height: 720 }
};

type BaseLayerContext = {
  id: string;
  mode: VisualLayer['mode'];
  smoothed: LayerFrame;
  dispose: () => void;
};

type TwoDLayerContext = BaseLayerContext & {
  type: '2d';
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  trailX: number;
  trailY: number;
  seed: number;
  raindrops: Map<number, Raindrop>;
  raindropLocalEventId: number;
  raindropLastTriggerAt: number;
  raindropPreviousTransient: number;
  historyPrimed?: boolean;
};

type StringResonatorLayerContext = BaseLayerContext & {
  type: 'stringResonator3d';
  group: THREE.Group;
  lines: THREE.LineSegments;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicMaterial;
  positions: Float32Array;
  colors: Float32Array;
  stringEnergy: number[];
  seenEventIds: Set<number>;
};

type TechniqueShardLayerContext = BaseLayerContext & {
  type: 'techniqueShard3d';
  group: THREE.Group;
  shards: THREE.InstancedMesh;
  material: THREE.MeshStandardMaterial;
  ringLines: THREE.LineSegments;
  ringGeometry: THREE.BufferGeometry;
  ringMaterial: THREE.LineBasicMaterial;
  ringPositions: Float32Array;
  ringColors: Float32Array;
  seeds: ShardSeed[];
};

type FormsLayerContext = BaseLayerContext & {
  type: 'forms3d';
  group: THREE.Group;
  geometrySet: THREE.BufferGeometry[];
  material: THREE.MeshStandardMaterial;
  mesh: THREE.Mesh;
  particles: Particle[];
  particleGeometry: THREE.BufferGeometry;
  particleMaterial: THREE.PointsMaterial;
  particlePositions: Float32Array;
  particleColors: Float32Array;
  lastGeometryMode: number;
};

type SpectralLayerContext = BaseLayerContext & {
  type: 'spectralField3d';
  group: THREE.Group;
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  positions: Float32Array;
  colors: Float32Array;
  seeds: SeedPoint[];
};

type ChromaLayerContext = BaseLayerContext & {
  type: 'chromaConstellation3d';
  group: THREE.Group;
  nodes: THREE.Mesh[];
  nodeMaterials: THREE.MeshStandardMaterial[];
  lineGeometry: THREE.BufferGeometry;
  lineMaterial: THREE.LineBasicMaterial;
  lines: THREE.LineSegments;
  linePositions: Float32Array;
  lineColors: Float32Array;
  particles: Particle[];
  particleGeometry: THREE.BufferGeometry;
  particleMaterial: THREE.PointsMaterial;
  particlePositions: Float32Array;
  particleColors: Float32Array;
};

type GuitarGlyphLayerContext = BaseLayerContext & {
  type: 'guitarGlyph3d';
  group: THREE.Group;
  stringLines: THREE.LineSegments;
  stringGeometry: THREE.BufferGeometry;
  stringMaterial: THREE.LineBasicMaterial;
  fretBars: THREE.Mesh[];
  noteNodes: THREE.Mesh[];
  noteMaterials: THREE.MeshStandardMaterial[];
  spectrum: THREE.InstancedMesh;
  spectrumMaterial: THREE.MeshStandardMaterial;
  eventParticles: Particle[];
  particleGeometry: THREE.BufferGeometry;
  particleMaterial: THREE.PointsMaterial;
  particlePositions: Float32Array;
  particleColors: Float32Array;
  seenEventIds: Set<number>;
};

type LayerContext =
  | TwoDLayerContext
  | FormsLayerContext
  | SpectralLayerContext
  | ChromaLayerContext
  | GuitarGlyphLayerContext
  | StringResonatorLayerContext
  | TechniqueShardLayerContext;

type RecordingState = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  frameCount: number;
  startedAt: number;
  accumulationAlpha: number;
  transparentBackground: boolean;
};

export type VisualCaptureOptions = {
  width: number;
  height: number;
  transparentBackground: boolean;
  accumulationAlpha?: number;
};

export type VisualRecordingResult = {
  dataUrl: string;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
};

export type VisualMediaRecordingResult = {
  dataUrl: string;
  mimeType: string;
  extension: 'webm';
  durationMs: number;
};

export type VisualSynthHandle = {
  captureStill: (options: VisualCaptureOptions) => VisualRecordingResult | null;
  startRecording: (options: VisualCaptureOptions) => void;
  stopRecording: () => VisualRecordingResult | null;
  startVideoRecording: (options: VisualCaptureOptions) => Promise<void>;
  stopVideoRecording: () => Promise<VisualMediaRecordingResult | null>;
};

export const VisualSynth = forwardRef<VisualSynthHandle, {
  featuresRef: React.MutableRefObject<AudioFeatures>;
  layers: VisualLayer[];
  transparentBackground: boolean;
  renderQuality: VisualRenderQuality;
}>(function VisualSynth({ featuresRef, layers, transparentBackground, renderQuality }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const layersRef = useRef(layers);
  const transparentBackgroundRef = useRef(transparentBackground);
  const renderQualityRef = useRef(renderQuality);
  const startRecordingRef = useRef<(options: VisualCaptureOptions) => void>(() => undefined);
  const captureStillRef = useRef<(options: VisualCaptureOptions) => VisualRecordingResult | null>(() => null);
  const startVideoRecordingRef = useRef<(options: VisualCaptureOptions) => Promise<void>>(async () => undefined);
  const stopRecordingRef = useRef<() => VisualRecordingResult | null>(() => null);
  const stopVideoRecordingRef = useRef<() => Promise<VisualMediaRecordingResult | null>>(async () => null);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  useEffect(() => {
    transparentBackgroundRef.current = transparentBackground;
  }, [transparentBackground]);

  useEffect(() => {
    renderQualityRef.current = renderQuality;
    window.dispatchEvent(new Event('resize'));
  }, [renderQuality]);

  useImperativeHandle(
    ref,
    () => ({
      captureStill: (options) => captureStillRef.current(options),
      startRecording: (options) => startRecordingRef.current(options),
      stopRecording: () => stopRecordingRef.current(),
      startVideoRecording: (options) => startVideoRecordingRef.current(options),
      stopVideoRecording: () => stopVideoRecordingRef.current()
    }),
    []
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x07090a, 0.08);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
    camera.position.set(0, 1.2, 7.5);

    const renderer = createRenderer();
    renderer.domElement.className = 'visual-3d-canvas';
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setClearColor(0x07090a, 1);
    const twoDHost = document.createElement('div');
    twoDHost.className = 'visual-2d-stack';
    host.appendChild(twoDHost);
    host.appendChild(renderer.domElement);

    const key = new THREE.PointLight(0xb6fbff, 26, 30);
    key.position.set(3, 4, 5);
    scene.add(key);
    const fill = new THREE.PointLight(0xff7a45, 10, 25);
    fill.position.set(-3, -2, 4);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0x6c7880, 0.9));

    const layerContexts = new Map<string, LayerContext>();
    const recordingRef = { current: null as RecordingState | null };
    const videoRef = { current: null as {
      recorder: MediaRecorder;
      chunks: Blob[];
      startedAt: number;
      stream: MediaStream;
      canvas: HTMLCanvasElement;
      context: CanvasRenderingContext2D;
      transparentBackground: boolean;
    } | null };
    let animation = 0;
    let last = performance.now();

    captureStillRef.current = (options) => {
      const canvas = document.createElement('canvas');
      canvas.width = options.width;
      canvas.height = options.height;
      const context = canvas.getContext('2d', { alpha: options.transparentBackground })!;
      if (!options.transparentBackground) {
        context.fillStyle = '#07090a';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      drawVisualFrameToContext(context, canvas.width, canvas.height, layerContexts, renderer.domElement, options.transparentBackground);
      return {
        dataUrl: canvas.toDataURL('image/png'),
        width: canvas.width,
        height: canvas.height,
        frameCount: 1,
        durationMs: 0
      };
    };

    startRecordingRef.current = (options) => {
      const canvas = document.createElement('canvas');
      canvas.width = options.width;
      canvas.height = options.height;
      const context = canvas.getContext('2d', { alpha: options.transparentBackground })!;
      if (!options.transparentBackground) {
        context.fillStyle = '#07090a';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      recordingRef.current = {
        canvas,
        context,
        frameCount: 0,
        startedAt: performance.now(),
        accumulationAlpha: options.accumulationAlpha ?? 0.16,
        transparentBackground: options.transparentBackground
      };
    };

    startVideoRecordingRef.current = async (options) => {
      if (videoRef.current) {
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = options.width;
      canvas.height = options.height;
      const context = canvas.getContext('2d', { alpha: options.transparentBackground })!;
      const stream = canvas.captureStream(60);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };
      videoRef.current = {
        recorder,
        chunks,
        stream,
        canvas,
        context,
        transparentBackground: options.transparentBackground,
        startedAt: performance.now()
      };
      recorder.start(250);
    };

    stopRecordingRef.current = () => {
      const recording = recordingRef.current;
      recordingRef.current = null;
      if (!recording || recording.frameCount === 0) {
        return null;
      }
      return {
        dataUrl: recording.canvas.toDataURL('image/png'),
        width: recording.canvas.width,
        height: recording.canvas.height,
        frameCount: recording.frameCount,
        durationMs: Math.max(0, performance.now() - recording.startedAt)
      };
    };

    stopVideoRecordingRef.current = async () => {
      const video = videoRef.current;
      videoRef.current = null;
      if (!video) {
        return null;
      }
      const result = await new Promise<VisualMediaRecordingResult | null>((resolve) => {
        video.recorder.onstop = async () => {
          video.stream.getTracks().forEach((track) => track.stop());
          const blob = new Blob(video.chunks, { type: video.recorder.mimeType || 'video/webm' });
          if (!blob.size) {
            resolve(null);
            return;
          }
          const dataUrl = await blobToDataUrl(blob);
          resolve({
            dataUrl,
            mimeType: blob.type || 'video/webm',
            extension: 'webm',
            durationMs: Math.max(0, performance.now() - video.startedAt)
          });
        };
        video.recorder.stop();
      });
      return result;
    };

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      layerContexts.forEach((context) => {
        if (context.type === '2d') {
          resizeCanvasLayer(context, width, height, renderQualityRef.current);
        }
      });
    };
    resize();
    window.addEventListener('resize', resize);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    const animate = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const features = featuresRef.current;
      const activeLayers = layersRef.current;
      const hasVisible2DLayers = activeLayers.some((layer) => layer.enabled && is2DLayerMode(layer.mode));
      renderer.setClearColor(0x07090a, transparentBackgroundRef.current || hasVisible2DLayers ? 0 : 1);

      reconcileLayerContexts(scene, twoDHost, layerContexts, activeLayers, host.clientWidth, host.clientHeight, renderQualityRef.current);

      let aggregateLow = 0;
      let aggregateMid = 0;
      let aggregateHigh = 0;
      let aggregateRms = 0;
      let renderedLayerCount = 0;
      activeLayers.forEach((layer, index) => {
        const context = layerContexts.get(layer.id);
        if (!context) {
          return;
        }
        if (!layer.enabled) {
          hideLayerContext(context);
          return;
        }

        const frame = getLayerFrame(context, layer, features);
        aggregateLow += frame.low;
        aggregateMid += frame.mid;
        aggregateHigh += frame.high;
        aggregateRms += frame.rms;
        renderedLayerCount += 1;

        if (context.type === '2d') {
          render2DLayer(context, layer, frame, features, dt, now, index);
        } else if (context.type === 'forms3d') {
          renderFormsLayer(context, layer, frame, features, dt, index);
        } else if (context.type === 'spectralField3d') {
          renderSpectralFieldLayer(context, layer, frame, now, index);
        } else if (context.type === 'chromaConstellation3d') {
          renderChromaConstellationLayer(context, layer, frame, features, dt, now, index);
        } else if (context.type === 'guitarGlyph3d') {
          renderGuitarGlyphLayer(context, layer, frame, features, dt, now, index);
        } else if (context.type === 'stringResonator3d') {
          renderStringResonatorLayer(context, layer, frame, features, dt, now, index);
        } else {
          renderTechniqueShardLayer(context, layer, frame, features, dt, now, index);
        }
      });

      const layerCount = Math.max(1, renderedLayerCount);
      aggregateLow /= layerCount;
      aggregateMid /= layerCount;
      aggregateHigh /= layerCount;
      aggregateRms /= layerCount;
      key.intensity = 10 + aggregateRms * 46 + features.onset * 38;
      fill.intensity = 4 + aggregateHigh * 28;
      camera.position.x += ((aggregateHigh - 0.5) * 0.65 + features.onset * 0.18 - camera.position.x) * 0.045;
      camera.position.y += (1.0 + aggregateMid * 0.7 - camera.position.y) * 0.035;
      camera.position.z += (7.5 - aggregateLow * 2.5 - features.onset * 0.7 - camera.position.z) * 0.035;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
      captureRecordingFrame(recordingRef.current, renderer.domElement, layerContexts);
      captureVideoFrame(videoRef.current, renderer.domElement, layerContexts);
      animation = requestAnimationFrame(animate);
    };

    animation = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animation);
      window.removeEventListener('resize', resize);
      resizeObserver.disconnect();
      startRecordingRef.current = () => undefined;
      stopRecordingRef.current = () => null;
      stopVideoRecordingRef.current = async () => null;
      startVideoRecordingRef.current = async () => undefined;
      captureStillRef.current = () => null;
      layerContexts.forEach((context) => context.dispose());
      layerContexts.clear();
      try {
        renderer.dispose();
      } catch {
        // WebGL teardown can race React StrictMode remounts in development.
      }
      if (renderer.domElement.parentElement === host) {
        host.removeChild(renderer.domElement);
      }
      if (twoDHost.parentElement === host) {
        host.removeChild(twoDHost);
      }
    };
  }, [featuresRef]);

  return <div className="visual-host" ref={hostRef} />;
});

function reconcileLayerContexts(
  scene: THREE.Scene,
  twoDHost: HTMLElement,
  contexts: Map<string, LayerContext>,
  layers: VisualLayer[],
  width: number,
  height: number,
  renderQuality: VisualRenderQuality
) {
  const liveIds = new Set(layers.map((layer) => layer.id));
  contexts.forEach((context, id) => {
    if (!liveIds.has(id)) {
      context.dispose();
      contexts.delete(id);
    }
  });

  layers.forEach((layer, index) => {
    const existing = contexts.get(layer.id);
    if (existing && existing.mode === layer.mode) {
      setLayerRenderOrder(existing, index);
      return;
    }
    if (existing) {
      existing.dispose();
      contexts.delete(layer.id);
    }

    const context = createLayerContext(scene, twoDHost, layer, width, height, renderQuality);
    contexts.set(layer.id, context);
    setLayerRenderOrder(context, index);
  });
}

function createLayerContext(
  scene: THREE.Scene,
  twoDHost: HTMLElement,
  layer: VisualLayer,
  width: number,
  height: number,
  renderQuality: VisualRenderQuality
): LayerContext {
  if (is2DLayerMode(layer.mode)) {
    return create2DLayerContext(twoDHost, layer, width, height, renderQuality);
  }
  if (layer.mode === 'forms3d') {
    return createFormsLayerContext(scene, layer);
  }
  if (layer.mode === 'chromaConstellation3d') {
    return createChromaLayerContext(scene, layer);
  }
  if (layer.mode === 'guitarGlyph3d') {
    return createGuitarGlyphLayerContext(scene, layer);
  }
  if (layer.mode === 'stringResonator3d') {
    return createStringResonatorLayerContext(scene, layer);
  }
  if (layer.mode === 'techniqueShard3d') {
    return createTechniqueShardLayerContext(scene, layer);
  }
  return createSpectralFieldLayerContext(scene, layer);
}

function is2DLayerMode(mode: VisualLayer['mode']): boolean {
  return mode === 'trails2d' || mode === 'lineArt2d' || mode === 'fretPulse2d' || mode === 'raindrops2d' || mode === 'techniqueMap2d' || mode === 'sideScroller2d';
}

function create2DLayerContext(
  twoDHost: HTMLElement,
  layer: VisualLayer,
  width: number,
  height: number,
  renderQuality: VisualRenderQuality
): TwoDLayerContext {
  const canvas = document.createElement('canvas');
  canvas.className = 'visual-2d-layer';
  const context = canvas.getContext('2d', { alpha: true })!;
  twoDHost.appendChild(canvas);

  const layerContext: TwoDLayerContext = {
    id: layer.id,
    mode: layer.mode,
    type: '2d',
    canvas,
    context,
    trailX: 0.5,
    trailY: 0.5,
    seed: Math.random() * 1000,
    raindrops: new Map(),
    raindropLocalEventId: -1,
    raindropLastTriggerAt: -10,
    raindropPreviousTransient: 0,
    smoothed: createEmptyFrame(),
    dispose: () => {
      if (canvas.parentElement === twoDHost) {
        twoDHost.removeChild(canvas);
      }
    }
  };
  resizeCanvasLayer(layerContext, width, height, renderQuality);
  return layerContext;
}

function createFormsLayerContext(scene: THREE.Scene, layer: VisualLayer): FormsLayerContext {
  const group = new THREE.Group();
  scene.add(group);
  const geometrySet = createChromaticGeometries();
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.58, 0.82, 0.58),
    metalness: 0.22,
    roughness: 0.38,
    emissive: new THREE.Color(0x081014),
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: layer.controls.opacity
  });
  const mesh = new THREE.Mesh(geometrySet[0], material);
  group.add(mesh);

  const maxParticles = 320;
  const particleGeometry = new THREE.BufferGeometry();
  const particlePositions = new Float32Array(maxParticles * 3);
  const particleColors = new Float32Array(maxParticles * 3);
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
  particleGeometry.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
  const particleMaterial = new THREE.PointsMaterial({
    size: 0.045,
    vertexColors: true,
    transparent: true,
    opacity: layer.controls.opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const particlePoints = new THREE.Points(particleGeometry, particleMaterial);
  group.add(particlePoints);

  return {
    id: layer.id,
    mode: layer.mode,
    type: 'forms3d',
    group,
    geometrySet,
    material,
    mesh,
    particles: [],
    particleGeometry,
    particleMaterial,
    particlePositions,
    particleColors,
    lastGeometryMode: 0,
    smoothed: createEmptyFrame(),
    dispose: () => {
      scene.remove(group);
      geometrySet.forEach((geometry) => geometry.dispose());
      material.dispose();
      particleGeometry.dispose();
      particleMaterial.dispose();
    }
  };
}

function createSpectralFieldLayerContext(scene: THREE.Scene, layer: VisualLayer): SpectralLayerContext {
  const group = new THREE.Group();
  scene.add(group);
  const count = 720;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const seeds: SeedPoint[] = Array.from({ length: count }, (_, index) => ({
    angle: (index / count) * Math.PI * 2 * 7 + Math.random() * 0.18,
    radius: 0.25 + Math.random() * 3.2,
    band: (index % 3) as 0 | 1 | 2,
    drift: Math.random() * Math.PI * 2
  }));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 0.035,
    vertexColors: true,
    transparent: true,
    opacity: layer.controls.opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const points = new THREE.Points(geometry, material);
  group.add(points);

  return {
    id: layer.id,
    mode: layer.mode,
    type: 'spectralField3d',
    group,
    points,
    geometry,
    material,
    positions,
    colors,
    seeds,
    smoothed: createEmptyFrame(),
    dispose: () => {
      scene.remove(group);
      geometry.dispose();
      material.dispose();
    }
  };
}

function createChromaLayerContext(scene: THREE.Scene, layer: VisualLayer): ChromaLayerContext {
  const group = new THREE.Group();
  scene.add(group);
  const nodeGeometry = new THREE.SphereGeometry(0.11, 18, 12);
  const nodes: THREE.Mesh[] = [];
  const nodeMaterials: THREE.MeshStandardMaterial[] = [];
  for (let index = 0; index < 12; index += 1) {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(index / 12, 0.78, 0.34),
      emissive: new THREE.Color().setHSL(index / 12, 0.7, 0.08),
      emissiveIntensity: 0.4,
      metalness: 0.14,
      roughness: 0.42,
      transparent: true,
      opacity: layer.controls.opacity
    });
    const mesh = new THREE.Mesh(nodeGeometry, material);
    const angle = (index / 12) * Math.PI * 2 - Math.PI / 2;
    mesh.position.set(Math.cos(angle) * 2.2, Math.sin(angle) * 2.2, 0);
    nodes.push(mesh);
    nodeMaterials.push(material);
    group.add(mesh);
  }

  const linePositions = new Float32Array(12 * 2 * 3);
  const lineColors = new Float32Array(12 * 2 * 3);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  lineGeometry.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
  const lineMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: layer.controls.opacity * 0.72,
    blending: THREE.AdditiveBlending
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  group.add(lines);

  const particleGeometry = new THREE.BufferGeometry();
  const particlePositions = new Float32Array(240 * 3);
  const particleColors = new Float32Array(240 * 3);
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
  particleGeometry.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
  const particleMaterial = new THREE.PointsMaterial({
    size: 0.038,
    vertexColors: true,
    transparent: true,
    opacity: layer.controls.opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const particlePoints = new THREE.Points(particleGeometry, particleMaterial);
  group.add(particlePoints);

  return {
    id: layer.id,
    mode: layer.mode,
    type: 'chromaConstellation3d',
    group,
    nodes,
    nodeMaterials,
    lineGeometry,
    lineMaterial,
    lines,
    linePositions,
    lineColors,
    particles: [],
    particleGeometry,
    particleMaterial,
    particlePositions,
    particleColors,
    smoothed: createEmptyFrame(),
    dispose: () => {
      scene.remove(group);
      nodeGeometry.dispose();
      nodeMaterials.forEach((material) => material.dispose());
      lineGeometry.dispose();
      lineMaterial.dispose();
      particleGeometry.dispose();
      particleMaterial.dispose();
    }
  };
}

function createGuitarGlyphLayerContext(scene: THREE.Scene, layer: VisualLayer): GuitarGlyphLayerContext {
  const group = new THREE.Group();
  scene.add(group);

  const stringPositions = new Float32Array(6 * 2 * 3);
  for (let index = 0; index < 6; index += 1) {
    const y = 1.1 - index * 0.44;
    const offset = index * 6;
    stringPositions[offset] = -2.65;
    stringPositions[offset + 1] = y;
    stringPositions[offset + 2] = 0;
    stringPositions[offset + 3] = 2.65;
    stringPositions[offset + 4] = y;
    stringPositions[offset + 5] = 0;
  }
  const stringGeometry = new THREE.BufferGeometry();
  stringGeometry.setAttribute('position', new THREE.BufferAttribute(stringPositions, 3));
  const stringMaterial = new THREE.LineBasicMaterial({
    color: 0xd7e6df,
    transparent: true,
    opacity: layer.controls.opacity * 0.58
  });
  const stringLines = new THREE.LineSegments(stringGeometry, stringMaterial);
  group.add(stringLines);

  const fretBars: THREE.Mesh[] = [];
  const fretGeometry = new THREE.BoxGeometry(0.018, 2.55, 0.035);
  const fretMaterial = new THREE.MeshStandardMaterial({
    color: 0x9fb8b1,
    roughness: 0.5,
    metalness: 0.25,
    transparent: true,
    opacity: layer.controls.opacity * 0.5
  });
  const fretSpan = Math.max(5, Math.min(24, Math.round(layer.controls.fretSpan ?? 12)));
  for (let fret = 0; fret <= fretSpan; fret += 1) {
    const bar = new THREE.Mesh(fretGeometry, fretMaterial.clone());
    bar.position.set(fretToX(fret, fretSpan), 0, -0.02);
    bar.scale.x = fret === 0 || fret === fretSpan ? 1.8 : 1;
    fretBars.push(bar);
    group.add(bar);
  }

  const noteNodes: THREE.Mesh[] = [];
  const noteMaterials: THREE.MeshStandardMaterial[] = [];
  const noteGeometry = new THREE.SphereGeometry(0.105, 18, 12);
  for (let index = 0; index < 6; index += 1) {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.08 + index * 0.09, 0.74, 0.52),
      emissive: new THREE.Color().setHSL(0.08 + index * 0.09, 0.7, 0.08),
      emissiveIntensity: 0.6,
      roughness: 0.36,
      metalness: 0.12,
      transparent: true,
      opacity: 0
    });
    const node = new THREE.Mesh(noteGeometry, material);
    noteNodes.push(node);
    noteMaterials.push(material);
    group.add(node);
  }

  const spectrumGeometry = new THREE.BoxGeometry(0.075, 1, 0.075);
  const spectrumMaterial = new THREE.MeshStandardMaterial({
    color: 0x75d0ff,
    emissive: 0x0a2530,
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: layer.controls.opacity * 0.72
  });
  const spectrum = new THREE.InstancedMesh(spectrumGeometry, spectrumMaterial, 36);
  group.add(spectrum);

  const particleGeometry = new THREE.BufferGeometry();
  const particlePositions = new Float32Array(260 * 3);
  const particleColors = new Float32Array(260 * 3);
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
  particleGeometry.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
  const particleMaterial = new THREE.PointsMaterial({
    size: 0.045,
    vertexColors: true,
    transparent: true,
    opacity: layer.controls.opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const particlePoints = new THREE.Points(particleGeometry, particleMaterial);
  group.add(particlePoints);

  return {
    id: layer.id,
    mode: layer.mode,
    type: 'guitarGlyph3d',
    group,
    stringLines,
    stringGeometry,
    stringMaterial,
    fretBars,
    noteNodes,
    noteMaterials,
    spectrum,
    spectrumMaterial,
    eventParticles: [],
    particleGeometry,
    particleMaterial,
    particlePositions,
    particleColors,
    seenEventIds: new Set(),
    smoothed: createEmptyFrame(),
    dispose: () => {
      scene.remove(group);
      stringGeometry.dispose();
      stringMaterial.dispose();
      fretGeometry.dispose();
      fretMaterial.dispose();
      fretBars.forEach((bar) => (bar.material as THREE.Material).dispose());
      noteGeometry.dispose();
      noteMaterials.forEach((material) => material.dispose());
      spectrumGeometry.dispose();
      spectrumMaterial.dispose();
      spectrum.dispose();
      particleGeometry.dispose();
      particleMaterial.dispose();
    }
  };
}

function createStringResonatorLayerContext(scene: THREE.Scene, layer: VisualLayer): StringResonatorLayerContext {
  const group = new THREE.Group();
  scene.add(group);
  const stringCount = 6;
  const segments = 56;
  const positions = new Float32Array(stringCount * (segments - 1) * 2 * 3);
  const colors = new Float32Array(stringCount * (segments - 1) * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: layer.controls.opacity,
    blending: THREE.AdditiveBlending
  });
  const lines = new THREE.LineSegments(geometry, material);
  group.add(lines);

  return {
    id: layer.id,
    mode: layer.mode,
    type: 'stringResonator3d',
    group,
    lines,
    geometry,
    material,
    positions,
    colors,
    stringEnergy: Array.from({ length: stringCount }, () => 0),
    seenEventIds: new Set(),
    smoothed: createEmptyFrame(),
    dispose: () => {
      scene.remove(group);
      geometry.dispose();
      material.dispose();
    }
  };
}

function createTechniqueShardLayerContext(scene: THREE.Scene, layer: VisualLayer): TechniqueShardLayerContext {
  const group = new THREE.Group();
  scene.add(group);
  const count = 108;
  const shardGeometry = new THREE.BoxGeometry(0.055, 0.32, 0.055, 1, 3, 1);
  const material = new THREE.MeshStandardMaterial({
    color: 0xf2b36c,
    emissive: 0x241207,
    emissiveIntensity: 0.7,
    metalness: 0.18,
    roughness: 0.44,
    transparent: true,
    opacity: layer.controls.opacity
  });
  const shards = new THREE.InstancedMesh(shardGeometry, material, count);
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(shards);

  const ringPositions = new Float32Array(12 * 2 * 3);
  const ringColors = new Float32Array(12 * 2 * 3);
  const ringGeometry = new THREE.BufferGeometry();
  ringGeometry.setAttribute('position', new THREE.BufferAttribute(ringPositions, 3));
  ringGeometry.setAttribute('color', new THREE.BufferAttribute(ringColors, 3));
  const ringMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: layer.controls.opacity * 0.55,
    blending: THREE.AdditiveBlending
  });
  const ringLines = new THREE.LineSegments(ringGeometry, ringMaterial);
  group.add(ringLines);

  const seeds: ShardSeed[] = Array.from({ length: count }, (_, index) => ({
    angle: (index / count) * Math.PI * 2 * 5 + Math.random() * 0.22,
    radius: 0.45 + Math.random() * 2.65,
    height: -1.25 + Math.random() * 2.5,
    phase: Math.random() * Math.PI * 2,
    techniqueBias: Math.random()
  }));

  return {
    id: layer.id,
    mode: layer.mode,
    type: 'techniqueShard3d',
    group,
    shards,
    material,
    ringLines,
    ringGeometry,
    ringMaterial,
    ringPositions,
    ringColors,
    seeds,
    smoothed: createEmptyFrame(),
    dispose: () => {
      scene.remove(group);
      shardGeometry.dispose();
      material.dispose();
      shards.dispose();
      ringGeometry.dispose();
      ringMaterial.dispose();
    }
  };
}

function resizeCanvasLayer(layer: TwoDLayerContext, width: number, height: number, renderQuality: VisualRenderQuality) {
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  const limit = renderQuality === 'high' ? null : TWO_D_QUALITY_LIMITS[renderQuality];
  const ratio = limit
    ? Math.min(
        pixelRatio,
        limit.width / Math.max(1, width),
        limit.height / Math.max(1, height),
        Math.sqrt((limit.width * limit.height) / Math.max(1, width * height))
      )
    : pixelRatio;
  const canvasWidth = Math.max(1, Math.floor(width * ratio));
  const canvasHeight = Math.max(1, Math.floor(height * ratio));
  if (layer.canvas.width === canvasWidth && layer.canvas.height === canvasHeight) {
    return;
  }
  layer.canvas.width = canvasWidth;
  layer.canvas.height = canvasHeight;
  layer.historyPrimed = false;
  if (layer.mode === 'sideScroller2d') {
    layer.context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  } else {
    layer.context.fillStyle = '#0a0e10';
    layer.context.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
  }
}

function setLayerRenderOrder(context: LayerContext, index: number) {
  if (context.type === '2d') {
    context.canvas.style.zIndex = String(index);
  } else {
    context.group.renderOrder = index;
    context.group.children.forEach((child) => {
      child.renderOrder = index;
    });
  }
}

function captureRecordingFrame(
  recording: RecordingState | null,
  source: HTMLCanvasElement,
  layerContexts: Map<string, LayerContext>
) {
  if (!recording) {
    return;
  }
  const frame = document.createElement('canvas');
  frame.width = recording.canvas.width;
  frame.height = recording.canvas.height;
  const frameContext = frame.getContext('2d', { alpha: recording.transparentBackground })!;
  drawVisualFrameToContext(frameContext, frame.width, frame.height, layerContexts, source, recording.transparentBackground);
  recording.context.globalCompositeOperation = recording.transparentBackground ? 'lighter' : 'lighten';
  recording.context.globalAlpha = recording.frameCount === 0 ? 1 : recording.accumulationAlpha;
  recording.context.drawImage(frame, 0, 0);
  recording.context.globalAlpha = 1;
  recording.context.globalCompositeOperation = 'source-over';
  recording.frameCount += 1;
}

function captureVideoFrame(
  recording: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; transparentBackground: boolean } | null,
  source: HTMLCanvasElement,
  layerContexts: Map<string, LayerContext>
) {
  if (!recording) {
    return;
  }
  drawVisualFrameToContext(recording.context, recording.canvas.width, recording.canvas.height, layerContexts, source, recording.transparentBackground);
}

function drawVisualFrameToContext(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  layerContexts: Map<string, LayerContext>,
  webglCanvas: HTMLCanvasElement,
  transparentBackground: boolean
) {
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  if (transparentBackground) {
    context.clearRect(0, 0, width, height);
  } else {
    context.fillStyle = '#07090a';
    context.fillRect(0, 0, width, height);
  }

  const twoDLayers = Array.from(layerContexts.values())
    .filter((layer): layer is TwoDLayerContext => layer.type === '2d' && layer.canvas.style.display !== 'none')
    .sort((a, b) => Number(a.canvas.style.zIndex || 0) - Number(b.canvas.style.zIndex || 0));

  twoDLayers.forEach((layer) => {
    context.globalAlpha = Number(layer.canvas.style.opacity || 1);
    context.drawImage(layer.canvas, 0, 0, width, height);
  });

  context.globalAlpha = 1;
  context.drawImage(webglCanvas, 0, 0, width, height);
}

function hideLayerContext(context: LayerContext) {
  if (context.type === '2d') {
    context.canvas.style.display = 'none';
  } else {
    context.group.visible = false;
  }
}

function getLayerFrame(context: LayerContext, layer: VisualLayer, features: AudioFeatures): LayerFrame {
  const controls = layer.controls;
  const gateOpen = features.rms >= controls.gateThreshold;
  const gateMultiplier = controls.requiresGate ? (gateOpen ? 1 : 0) : gateOpen ? 1 : 0.18;
  const sensitivity = controls.sensitivity;
  const target: LayerFrame = {
    rms: clamp01(features.rms * sensitivity * gateMultiplier),
    peak: clamp01(features.peak * sensitivity * gateMultiplier),
    low: clamp01(features.low * sensitivity * gateMultiplier),
    mid: clamp01(features.mid * sensitivity * gateMultiplier),
    high: clamp01(features.high * sensitivity * gateMultiplier),
    spectralCentroid: clamp01(features.spectralCentroid * (0.6 + sensitivity * 0.4)),
    spectralFlux: clamp01(features.spectralFlux * sensitivity * gateMultiplier),
    brightness: clamp01(features.brightness * sensitivity * gateMultiplier),
    noisiness: clamp01(features.noisiness * sensitivity * gateMultiplier),
    attack: clamp01(features.attack * sensitivity * gateMultiplier),
    vibratoDepth: clamp01(features.vibratoDepth * sensitivity * gateMultiplier),
    vibratoRate: clamp01(features.vibratoRate * sensitivity * gateMultiplier),
    onset: clamp01(Math.max(features.onset, features.spectralFlux) * sensitivity * gateMultiplier),
    noteStability: features.noteStability,
    gateOpen,
    hue: getFeatureHue(features)
  };
  const smoothing = Math.max(0, Math.min(0.98, controls.smoothing));
  const amount = 1 - smoothing;
  context.smoothed.rms += (target.rms - context.smoothed.rms) * amount;
  context.smoothed.peak += (target.peak - context.smoothed.peak) * amount;
  context.smoothed.low += (target.low - context.smoothed.low) * amount;
  context.smoothed.mid += (target.mid - context.smoothed.mid) * amount;
  context.smoothed.high += (target.high - context.smoothed.high) * amount;
  context.smoothed.spectralCentroid += (target.spectralCentroid - context.smoothed.spectralCentroid) * amount;
  context.smoothed.spectralFlux += (target.spectralFlux - context.smoothed.spectralFlux) * amount;
  context.smoothed.brightness += (target.brightness - context.smoothed.brightness) * amount;
  context.smoothed.noisiness += (target.noisiness - context.smoothed.noisiness) * amount;
  context.smoothed.attack += (target.attack - context.smoothed.attack) * amount;
  context.smoothed.vibratoDepth += (target.vibratoDepth - context.smoothed.vibratoDepth) * amount;
  context.smoothed.vibratoRate += (target.vibratoRate - context.smoothed.vibratoRate) * amount;
  context.smoothed.onset += (target.onset - context.smoothed.onset) * amount;
  context.smoothed.noteStability += (target.noteStability - context.smoothed.noteStability) * amount;
  context.smoothed.hue = lerpHue(context.smoothed.hue, target.hue, amount);
  context.smoothed.gateOpen = gateOpen;
  return context.smoothed;
}

function render2DLayer(
  layerContext: TwoDLayerContext,
  layer: VisualLayer,
  frame: LayerFrame,
  features: AudioFeatures,
  dt: number,
  now: number,
  index: number
) {
  const visible = layer.enabled && layer.controls.opacity > 0;
  layerContext.canvas.style.display = visible ? 'block' : 'none';
  layerContext.canvas.style.opacity = String(layer.controls.opacity);
  if (!visible) {
    return;
  }
  if (layer.mode === 'lineArt2d') {
    drawLineArt(layerContext, layer, frame, now, index);
  } else if (layer.mode === 'fretPulse2d') {
    drawFretPulse(layerContext, layer, frame, features, now);
  } else if (layer.mode === 'raindrops2d') {
    drawRaindrops(layerContext, layer, frame, features);
  } else if (layer.mode === 'techniqueMap2d') {
    drawTechniqueMap(layerContext, layer, frame, features, now);
  } else if (layer.mode === 'sideScroller2d') {
    drawSideScroller(layerContext, layer, frame, features, dt, now);
  } else {
    drawTrails(layerContext, layer, frame, dt, now);
  }
}

function drawTrails(layerContext: TwoDLayerContext, layer: VisualLayer, frame: LayerFrame, dt: number, now: number) {
  const { context, canvas } = layerContext;
  const baseFade = layer.controls.trailFade ?? 0.028;
  const fade = frame.gateOpen ? baseFade - frame.rms * baseFade * 0.42 : baseFade * 1.65;
  context.fillStyle = `rgba(10, 14, 16, ${Math.max(0.006, fade)})`;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const cx = layerContext.trailX * canvas.width;
  const cy = layerContext.trailY * canvas.height;
  const radius = 20 + frame.low * 280 * layer.controls.scaleAmount + frame.rms * 160;
  const count = 4 + Math.floor(frame.mid * 18 + frame.onset * 24);
  const alpha = 0.12 + frame.rms * 0.38;

  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.globalCompositeOperation = 'lighter';

  for (let i = 0; i < count; i += 1) {
    const phase = i / Math.max(1, count - 1);
    const angle = now * 0.0006 * layer.controls.motionAmount + phase * Math.PI * 2 + frame.high * 2;
    const x = cx + Math.cos(angle) * radius * (0.2 + phase);
    const y = cy + Math.sin(angle * (1.0 + frame.noteStability * 0.5)) * radius * (0.2 + frame.spectralCentroid);
    context.strokeStyle = `hsla(${Math.round(frame.hue * 360 + phase * 50 * layer.controls.colorAmount)}, ${78 + frame.high * 18}%, ${58 + frame.rms * 28}%, ${alpha})`;
    context.lineWidth = 1 + frame.rms * 14 + frame.onset * 10;
    context.beginPath();
    context.moveTo(cx, cy);
    context.quadraticCurveTo((cx + x) / 2, y + Math.sin(dt + phase) * 50, x, y);
    context.stroke();
  }

  context.globalCompositeOperation = 'source-over';
  layerContext.trailX = wrap01(layerContext.trailX + Math.cos(now * 0.0019 + frame.mid * 4) * (0.002 + frame.mid * 0.006) * layer.controls.motionAmount);
  layerContext.trailY = wrap01(layerContext.trailY + Math.sin(now * 0.0016 + frame.high * 7) * (0.002 + frame.high * 0.006) * layer.controls.motionAmount);
}

function drawLineArt(layerContext: TwoDLayerContext, layer: VisualLayer, frame: LayerFrame, now: number, index: number) {
  const { context, canvas } = layerContext;
  context.fillStyle = `rgba(10, 14, 16, ${frame.gateOpen ? 0.005 : 0.012})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'lighter';
  context.lineCap = 'round';
  context.lineJoin = 'round';

  const centerX = canvas.width * (0.5 + Math.sin(now * 0.00011 + layerContext.seed) * 0.12 * layer.controls.motionAmount);
  const centerY = canvas.height * (0.5 + Math.cos(now * 0.00013 + layerContext.seed) * 0.12 * layer.controls.motionAmount);
  const complexity = layer.controls.lineComplexity ?? 1;
  const rings = 2 + Math.floor(frame.mid * 7 * complexity);
  const points = 5 + Math.floor(frame.high * 10 * complexity + (layer.controls.symmetry ?? 1) * 2);
  const baseRadius = Math.min(canvas.width, canvas.height) * (0.08 + frame.low * 0.24 * layer.controls.scaleAmount);

  for (let ring = 0; ring < rings; ring += 1) {
    const radius = baseRadius * (1 + ring * 0.42) + frame.onset * 80;
    const phase = now * 0.00018 * layer.controls.motionAmount + ring * 0.6 + index * 0.35;
    const lightness = 46 + frame.rms * 34 + ring * 3;
    context.strokeStyle = `hsla(${Math.round(frame.hue * 360 + ring * 24 * layer.controls.colorAmount)}, ${62 + frame.high * 24}%, ${lightness}%, ${0.1 + frame.rms * 0.32})`;
    context.lineWidth = (0.8 + frame.rms * 6 + ring * 0.28) * (layer.controls.lineWeight ?? 1);
    context.beginPath();
    for (let point = 0; point <= points; point += 1) {
      const pct = point / points;
      const angle = pct * Math.PI * 2 + phase;
      const mod = 1 + Math.sin(angle * 3 + frame.spectralCentroid * 4 + ring) * (0.08 + frame.mid * 0.22);
      const x = centerX + Math.cos(angle) * radius * mod;
      const y = centerY + Math.sin(angle) * radius * (0.72 + frame.noteStability * 0.38) * mod;
      if (point === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
  }

  context.globalCompositeOperation = 'source-over';
}

function drawFretPulse(layerContext: TwoDLayerContext, layer: VisualLayer, frame: LayerFrame, features: AudioFeatures, now: number) {
  const { context, canvas } = layerContext;
  const voicing = Array.isArray(features.voicing) ? features.voicing : [];
  const events = Array.isArray(features.guitarEvents) ? features.guitarEvents : [];
  context.fillStyle = `rgba(7, 10, 11, ${frame.gateOpen ? 0.02 : 0.045})`;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const left = canvas.width * 0.09;
  const right = canvas.width * 0.91;
  const top = canvas.height * 0.18;
  const bottom = canvas.height * 0.82;
  const width = right - left;
  const height = bottom - top;
  const fretSpan = Math.max(5, Math.min(24, Math.round(layer.controls.fretSpan ?? 12)));
  const color = new THREE.Color();

  context.globalCompositeOperation = 'lighter';
  context.lineCap = 'round';
  for (let string = 1; string <= 6; string += 1) {
    const y = top + ((6 - string) / 5) * height;
    const stringEnergy = getStringEnergy(features, string);
    context.strokeStyle = `hsla(${Math.round(frame.hue * 360 + string * 13)}, ${58 + frame.high * 22}%, ${34 + stringEnergy * 38}%, ${0.16 + layer.controls.opacity * 0.42})`;
    context.lineWidth = 1 + stringEnergy * 10 + (features.muteAmount ?? 0) * 5;
    context.beginPath();
    for (let point = 0; point <= 96; point += 1) {
      const x = left + (point / 96) * width;
      const wobble = Math.sin(point * 0.36 + now * 0.007 + string) * (stringEnergy * 8 + frame.vibratoDepth * 14) * layer.controls.motionAmount;
      if (point === 0) {
        context.moveTo(x, y + wobble);
      } else {
        context.lineTo(x, y + wobble);
      }
    }
    context.stroke();
  }

  for (let fret = 0; fret <= fretSpan; fret += 1) {
    const x = left + (fret / fretSpan) * width;
    const strong = fret === 0 || fret === 12 || fret === features.fretNumber;
    context.strokeStyle = `rgba(180, 205, 196, ${strong ? 0.34 + frame.attack * 0.28 : 0.11})`;
    context.lineWidth = strong ? 2.4 : 1;
    context.beginPath();
    context.moveTo(x, top - 16);
    context.lineTo(x, bottom + 16);
    context.stroke();
  }

  voicing.forEach((candidate) => {
    const confidence = clamp01(candidate.confidence);
    const x = left + (Math.max(0, Math.min(fretSpan, candidate.fretNumber)) / fretSpan) * width;
    const y = top + ((6 - Math.max(1, Math.min(6, candidate.stringNumber))) / 5) * height;
    const radius = (10 + confidence * 30 + frame.attack * 18) * (layer.controls.markerSize ?? layer.controls.scaleAmount);
    color.setHSL(wrap01(candidate.pitchClass / 12 + frame.hue * 0.05), 0.78, 0.48 + confidence * 0.22);
    const gradient = context.createRadialGradient(x, y, 1, x, y, radius * 1.8);
    gradient.addColorStop(0, `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${0.36 + confidence * 0.34})`);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius * 1.8, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${0.62 + confidence * 0.28})`;
    context.lineWidth = 1.2 + confidence * 3;
    context.beginPath();
    context.arc(x, y, radius * 0.52, 0, Math.PI * 2);
    context.stroke();
  });

  events.forEach((event) => {
    const age = Math.max(0, features.t - event.t);
    if (age > 1.3) {
      return;
    }
    const x = left + (Math.max(0, Math.min(fretSpan, event.fretNumber ?? features.fretNumber ?? 0)) / fretSpan) * width;
    const y = top + ((6 - Math.max(1, Math.min(6, event.stringNumber ?? features.stringNumber ?? 3))) / 5) * height;
    const alpha = (1 - age / 1.3) * clamp01(event.strength) * layer.controls.opacity;
    const radius = (age * 130 + 18 + frame.onset * 26) * (layer.controls.pulseDecay ?? layer.controls.scaleAmount);
    context.strokeStyle = `hsla(${Math.round(frame.hue * 360 + techniqueHueOffset(event.type))}, 82%, 62%, ${alpha})`;
    context.lineWidth = 1 + alpha * 8;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
  });

  if (features.bendCents && Math.abs(features.bendCents) > 8 && features.stringNumber && features.fretNumber !== null) {
    const x = left + (Math.max(0, Math.min(fretSpan, features.fretNumber ?? 0)) / fretSpan) * width;
    const y = top + ((6 - Math.max(1, Math.min(6, features.stringNumber))) / 5) * height;
    context.strokeStyle = `hsla(${Math.round(frame.hue * 360 + 190)}, 82%, 64%, ${0.18 + clamp01(Math.abs(features.bendCents) / 180) * 0.52})`;
    context.lineWidth = 2 + clamp01(Math.abs(features.bendCents) / 120) * 6;
    context.beginPath();
    context.moveTo(x - 36, y);
    context.quadraticCurveTo(x, y - Math.sign(features.bendCents) * 58, x + 48, y - Math.sign(features.bendCents) * 20);
    context.stroke();
  }

  context.globalCompositeOperation = 'source-over';
}

function drawRaindrops(layerContext: TwoDLayerContext, layer: VisualLayer, frame: LayerFrame, features: AudioFeatures) {
  const { context, canvas, raindrops } = layerContext;
  const lifetime = 1.25;
  const pluckSensitivity = Math.max(0, layer.controls.pluckSensitivity ?? 1);
  const pluckSeparation = Math.max(0, layer.controls.pluckSeparation ?? 0.055);
  const transient = clamp01(Math.max(features.onset, features.spectralFlux, features.attack * 0.85));
  const active = features.rms >= layer.controls.gateThreshold;

  context.globalCompositeOperation = 'source-over';
  context.fillStyle = `rgba(0, 0, 0, ${frame.gateOpen ? 0.045 : 0.075})`;
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (pluckSensitivity > 0 && active) {
    const threshold = Math.max(0.07, 0.32 / (0.7 + pluckSensitivity * 0.65));
    const riseThreshold = Math.max(0.015, threshold * 0.22);
    const transientRise = transient - layerContext.raindropPreviousTransient;
    const retriggerGap = Math.max(0.065, pluckSeparation);
    if (transient >= threshold && transientRise >= riseThreshold && features.t - layerContext.raindropLastTriggerAt > retriggerGap) {
      const id = layerContext.raindropLocalEventId--;
      raindrops.set(id, {
        x: 0.08 + Math.random() * 0.84,
        y: 0.08 + Math.random() * 0.84,
        strength: clamp01(transient * (0.85 + pluckSensitivity * 0.18) + frame.rms * 0.3),
        createdAt: features.t
      });
      layerContext.raindropLastTriggerAt = features.t;
    }
  }
  layerContext.raindropPreviousTransient = transient;

  context.globalCompositeOperation = 'lighter';
  context.lineCap = 'round';
  context.lineJoin = 'round';

  raindrops.forEach((drop, id) => {
    const age = Math.max(0, features.t - drop.createdAt);
    const progress = age / lifetime;
    if (progress > 1) {
      raindrops.delete(id);
      return;
    }

    const x = drop.x * canvas.width;
    const y = drop.y * canvas.height;
    const fade = Math.pow(1 - progress, 1.35);
    const strength = clamp01(drop.strength);
    const maxRadius = Math.min(canvas.width, canvas.height) * (0.12 + strength * 0.28) * layer.controls.scaleAmount;
    const baseRadius = 8 + progress * maxRadius;
    const ringCount = 3;

    for (let ring = 0; ring < ringCount; ring += 1) {
      const ringPhase = ring / ringCount;
      const radius = baseRadius * (1 + ringPhase * 0.36) + ring * 12;
      const alpha = fade * (0.34 + strength * 0.5) * (1 - ringPhase * 0.34) * layer.controls.opacity;
      context.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
      context.lineWidth = 0.9 + strength * 4.4 + (1 - progress) * 1.2;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.stroke();
    }
  });

  context.globalCompositeOperation = 'source-over';
}

function drawTechniqueMap(layerContext: TwoDLayerContext, layer: VisualLayer, frame: LayerFrame, features: AudioFeatures, now: number) {
  const { context, canvas } = layerContext;
  context.globalCompositeOperation = 'source-over';
  context.drawImage(canvas, -Math.max(1, Math.floor(2 + layer.controls.motionAmount * 3)), 0);
  context.fillStyle = `rgba(7, 10, 11, ${layer.controls.historyFade ?? 0.035})`;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const x = canvas.width - Math.max(4, Math.floor(canvas.width * 0.006));
  const columnWidth = Math.max(3, Math.floor(canvas.width * 0.01));
  const lanes = [
    clamp01(features.pickNoise ?? 0),
    clamp01(features.muteAmount ?? 0),
    clamp01(features.harmonicRatio ?? 0),
    clamp01(features.vibratoDepth ?? 0),
    clamp01(Math.abs(features.bendCents ?? 0) / 180),
    clamp01(features.chordConfidence ?? 0)
  ];
  const laneHeight = canvas.height / lanes.length;
  context.globalCompositeOperation = 'lighter';
  lanes.forEach((value, lane) => {
    const y = lane * laneHeight;
    const hue = wrap01(frame.hue + lane * 0.105 + getTechniqueIntensity(features) * 0.08);
    const height = Math.max(2, value * laneHeight * 0.78 * (layer.controls.laneGain ?? layer.controls.scaleAmount));
    context.fillStyle = `hsla(${Math.round(hue * 360)}, ${64 + value * 24}%, ${28 + value * 46}%, ${0.18 + value * 0.54})`;
    context.fillRect(x, y + laneHeight - height, columnWidth, height);

    const spectrum = Array.isArray(features.logSpectrum) ? features.logSpectrum : [];
    const spectrumValue = clamp01(spectrum[(lane * 5 + Math.floor(now * 0.01)) % Math.max(1, spectrum.length)] ?? 0);
    context.strokeStyle = `hsla(${Math.round((hue + 0.06) * 360)}, 82%, ${48 + spectrumValue * 26}%, ${0.08 + spectrumValue * 0.42})`;
    context.lineWidth = 1 + spectrumValue * 4;
    context.beginPath();
    context.moveTo(x - 2, y + laneHeight * 0.5);
    context.lineTo(x + columnWidth + spectrumValue * 34, y + laneHeight * (0.5 - (value - 0.5) * 0.7));
    context.stroke();
  });

  const events = Array.isArray(features.guitarEvents) ? features.guitarEvents : [];
  events.forEach((event) => {
    const age = Math.max(0, features.t - event.t);
    if (age > 1.2) {
      return;
    }
    const eventX = canvas.width - age * canvas.width * 0.44 * Math.max(0.4, layer.controls.motionAmount);
    const eventLane = eventLaneIndex(event.type);
    const y = eventLane * laneHeight + laneHeight * 0.5;
    const alpha = (1 - age / 1.2) * clamp01(event.strength) * layer.controls.opacity * (layer.controls.eventAccent ?? 1);
    context.strokeStyle = `hsla(${Math.round(frame.hue * 360 + techniqueHueOffset(event.type))}, 92%, 62%, ${alpha})`;
    context.lineWidth = 1 + alpha * 7;
    context.beginPath();
    context.moveTo(eventX, y - laneHeight * 0.34);
    context.lineTo(eventX, y + laneHeight * 0.34);
    context.stroke();
  });

  const chroma = Array.isArray(features.chroma) ? features.chroma : [];
  chroma.forEach((value, pitchClass) => {
    if (value < 0.16) {
      return;
    }
    const y = canvas.height - (pitchClass + 0.5) * (canvas.height / 12);
    context.fillStyle = `hsla(${Math.round((pitchClass / 12 + frame.hue * 0.06) * 360)}, 80%, ${34 + value * 36}%, ${0.05 + value * 0.22})`;
    context.fillRect(x - 2, y - 1, columnWidth + value * 28, 2 + value * 5);
  });

  context.globalCompositeOperation = 'source-over';
}

function drawSideScroller(layerContext: TwoDLayerContext, layer: VisualLayer, frame: LayerFrame, features: AudioFeatures, dt: number, now: number) {
  const { context, canvas } = layerContext;
  if (!layerContext.historyPrimed) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    layerContext.historyPrimed = true;
  }
  const scrollPx = Math.max(1, Math.floor((1.6 + layer.controls.motionAmount * 4.4) * Math.max(0.55, dt * 60)));
  const playheadX = canvas.width - Math.max(6, Math.floor(canvas.width * 0.008));
  const gain = layer.controls.scaleAmount;
  const accent = layer.controls.colorAmount;
  const pitchConfidence = clamp01(features.pitchConfidence ?? 0);
  const pitchY = getSideScrollerPitchY(features.pitchHz, features.spectralCentroid, canvas.height);
  const activity = clamp01(
    frame.rms * 0.48 +
      frame.onset * 0.32 +
      frame.spectralFlux * 0.28 +
      frame.attack * 0.28 +
      pitchConfidence * 0.18 +
      clamp01(features.guitarTechniqueConfidence ?? 0) * 0.12
  );

  context.globalCompositeOperation = 'source-over';
  context.drawImage(canvas, -scrollPx, 0);
  context.clearRect(canvas.width - scrollPx - 1, 0, scrollPx + 1, canvas.height);
  const historyFade = Math.max(0, layer.controls.historyFade ?? 0.014);
  context.globalCompositeOperation = 'destination-out';
  context.fillStyle = `rgba(0, 0, 0, ${Math.min(0.08, historyFade * 0.42)})`;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.globalCompositeOperation = 'screen';
  context.lineCap = 'round';
  drawSideScrollerSpectrum(context, canvas, layer, frame, features, playheadX, activity, gain);
  drawSideScrollerChroma(context, canvas, layer, frame, features, playheadX, activity, gain);
  drawSideScrollerVoicing(context, canvas, layer, frame, features, playheadX, activity, gain);

  if (pitchConfidence > 0.18 || activity > 0.08) {
    const radius = (5 + activity * 28 + pitchConfidence * 18) * Math.max(0.55, gain);
    const length = (34 + activity * 140 + frame.noteStability * 62) * Math.max(0.55, gain);
    const bend = clampSigned((features.bendCents ?? 0) / 220);
    const hue = wrap01(frame.hue + bend * 0.05);
    const alpha = Math.min(0.92, 0.18 + activity * 0.5 + pitchConfidence * 0.26);

    context.strokeStyle = `hsla(${Math.round(hue * 360)}, ${74 + frame.high * 20}%, ${48 + activity * 28}%, ${alpha})`;
    context.lineWidth = Math.max(1.5, radius * 0.34);
    context.beginPath();
    context.moveTo(playheadX - length, pitchY - bend * 42 * accent);
    context.quadraticCurveTo(playheadX - length * 0.42, pitchY - bend * 70 * accent, playheadX, pitchY);
    context.stroke();

    const color = new THREE.Color().setHSL(hue, 0.82, 0.48 + activity * 0.22);
    const gradient = context.createRadialGradient(playheadX, pitchY, 1, playheadX, pitchY, radius * 2.4);
    gradient.addColorStop(0, `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${0.32 + alpha * 0.42})`);
    gradient.addColorStop(0.42, `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${0.16 + alpha * 0.22})`);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(playheadX, pitchY, radius * 2.4, 0, Math.PI * 2);
    context.fill();
  }

  drawSideScrollerEvents(context, canvas, layer, frame, features, playheadX, activity, accent);

  const playheadAlpha = 0.18 + activity * 0.42 * Math.max(0.45, accent);
  const playheadGradient = context.createLinearGradient(playheadX - 10, 0, playheadX + 2, 0);
  playheadGradient.addColorStop(0, `rgba(90, 190, 210, 0)`);
  playheadGradient.addColorStop(0.72, `rgba(130, 230, 220, ${playheadAlpha})`);
  playheadGradient.addColorStop(1, `rgba(255, 255, 255, ${Math.min(0.86, playheadAlpha + frame.onset * 0.36)})`);
  context.fillStyle = playheadGradient;
  context.fillRect(playheadX - 10, 0, 12, canvas.height);
  context.globalCompositeOperation = 'source-over';
}

function drawSideScrollerSpectrum(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  layer: VisualLayer,
  frame: LayerFrame,
  features: AudioFeatures,
  playheadX: number,
  activity: number,
  gain: number
) {
  const spectrum = Array.isArray(features.logSpectrum) ? features.logSpectrum : [];
  if (spectrum.length === 0) {
    return;
  }
  const top = canvas.height * 0.08;
  const bottom = canvas.height * 0.92;
  const height = bottom - top;
  spectrum.forEach((raw, index) => {
    const value = clamp01(raw);
    if (value < 0.018) {
      return;
    }
    const pct = spectrum.length <= 1 ? 0 : index / (spectrum.length - 1);
    const y = bottom - pct * height;
    const binBand = pct < 0.33 ? frame.low : pct < 0.66 ? frame.mid : frame.high;
    const thickness = Math.max(1, (1 + value * 10 + activity * 7 + binBand * 5) * Math.max(0.5, gain));
    const length = (10 + value * 86 + activity * 54) * Math.max(0.55, gain);
    const hue = wrap01(frame.hue + pct * 0.28 + frame.spectralCentroid * 0.06);
    context.strokeStyle = `hsla(${Math.round(hue * 360)}, ${58 + value * 26}%, ${26 + value * 46}%, ${0.045 + value * 0.24 + activity * 0.1})`;
    context.lineWidth = thickness;
    context.beginPath();
    context.moveTo(playheadX - length, y);
    context.lineTo(playheadX, y);
    context.stroke();
  });
}

function drawSideScrollerChroma(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  layer: VisualLayer,
  frame: LayerFrame,
  features: AudioFeatures,
  playheadX: number,
  activity: number,
  gain: number
) {
  const chroma = Array.isArray(features.chroma) ? features.chroma : [];
  chroma.forEach((raw, pitchClass) => {
    const value = clamp01(raw);
    if (value < 0.12) {
      return;
    }
    const y = canvas.height * (0.9 - (pitchClass / 11) * 0.78);
    const length = (8 + value * 64 + activity * 38) * Math.max(0.55, gain);
    context.strokeStyle = `hsla(${Math.round(wrap01(pitchClass / 12 + frame.hue * 0.08) * 360)}, 78%, ${34 + value * 35}%, ${0.055 + value * 0.22})`;
    context.lineWidth = Math.max(1, (1.2 + value * 4.8) * Math.max(0.55, gain));
    context.beginPath();
    context.moveTo(playheadX - length, y);
    context.lineTo(playheadX - 2, y);
    context.stroke();
  });
}

function drawSideScrollerVoicing(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  layer: VisualLayer,
  frame: LayerFrame,
  features: AudioFeatures,
  playheadX: number,
  activity: number,
  gain: number
) {
  const voicing = Array.isArray(features.voicing) ? features.voicing : [];
  voicing.forEach((candidate, index) => {
    const confidence = clamp01(candidate.confidence);
    if (confidence < 0.08) {
      return;
    }
    const midi = getVoicingCandidateMidi(candidate.stringNumber, candidate.fretNumber);
    const y = getSideScrollerMidiY(midi, canvas.height);
    const x = playheadX - 12 - index * Math.max(8, canvas.width * 0.008);
    const radius = (3.5 + confidence * 12 + activity * 9) * Math.max(0.55, gain);
    context.fillStyle = `hsla(${Math.round(wrap01(candidate.pitchClass / 12 + frame.hue * 0.06) * 360)}, 84%, ${42 + confidence * 34}%, ${0.18 + confidence * 0.38})`;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  });
}

function drawSideScrollerEvents(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  layer: VisualLayer,
  frame: LayerFrame,
  features: AudioFeatures,
  playheadX: number,
  activity: number,
  accent: number
) {
  const events = Array.isArray(features.guitarEvents) ? features.guitarEvents : [];
  events.forEach((event) => {
    const age = Math.max(0, features.t - event.t);
    if (age > 0.9) {
      return;
    }
    const strength = clamp01(event.strength);
    const eventX = playheadX - age * canvas.width * 0.32 * Math.max(0.35, layer.controls.motionAmount);
    const eventY = event.pitchHz
      ? getSideScrollerPitchY(event.pitchHz, features.spectralCentroid, canvas.height)
      : getSideScrollerMidiY(getVoicingCandidateMidi(event.stringNumber ?? features.stringNumber ?? 3, event.fretNumber ?? features.fretNumber ?? 0), canvas.height);
    const alpha = (1 - age / 0.9) * strength * Math.max(0.2, accent);
    const radius = (8 + strength * 26 + frame.onset * 24 + activity * 14) * Math.max(0.45, accent);
    context.strokeStyle = `hsla(${Math.round(frame.hue * 360 + techniqueHueOffset(event.type))}, 88%, 62%, ${Math.min(0.9, alpha)})`;
    context.lineWidth = 1 + alpha * 6;
    context.beginPath();
    context.moveTo(eventX, eventY - radius);
    context.lineTo(eventX, eventY + radius);
    context.stroke();
    context.beginPath();
    context.arc(eventX, eventY, radius * 0.42, 0, Math.PI * 2);
    context.stroke();
  });
}

function renderFormsLayer(context: FormsLayerContext, layer: VisualLayer, frame: LayerFrame, features: AudioFeatures, dt: number, index: number) {
  context.group.visible = layer.enabled && layer.controls.opacity > 0;
  context.material.opacity = layer.controls.opacity;
  context.particleMaterial.opacity = layer.controls.opacity;
  if (!context.group.visible) {
    return;
  }

  const color = new THREE.Color();
  const warmth = 0.52 + frame.spectralCentroid * 0.3;
  color.setHSL(frame.hue, 0.76 + frame.high * 0.18 * layer.controls.colorAmount, warmth);
  context.material.color.lerp(color, 0.12);
  context.material.emissive.setHSL(frame.hue, 0.7, 0.05 + frame.rms * 0.18 * layer.controls.colorAmount);
  context.material.roughness = 0.68 - frame.spectralCentroid * 0.42;

  if (features.pitchConfidence > 0.42) {
    const nextMode = getPitchClassIndex(features.pitchHz);
    if (nextMode !== context.lastGeometryMode && features.noteStability > 0.45) {
      context.mesh.geometry = context.geometrySet[nextMode];
      context.lastGeometryMode = nextMode;
    }
  }

  const offset = (index - 1) * 0.55;
  context.group.position.set(offset, Math.sin(index) * 0.18, 0);
  const scale = 0.82 + frame.rms * 2.2 * layer.controls.scaleAmount + frame.low * 0.55;
  context.mesh.scale.setScalar(scale);
  context.mesh.rotation.x += dt * (0.32 + frame.mid * 2.5 + (1 - frame.noteStability) * 0.8) * layer.controls.motionAmount;
  context.mesh.rotation.y += dt * (0.22 + frame.high * 3.0) * layer.controls.motionAmount;
  context.mesh.rotation.z += dt * (frame.noteStability * 0.4) * layer.controls.motionAmount;

  if (frame.onset > 0.2) {
    spawnParticles(context.particles, context.particlePositions.length / 3, frame, layer.controls.particleBurst ?? 1);
  }
  updateParticles(context.particles, context.particlePositions, context.particleColors, dt, frame);
  context.particleGeometry.attributes.position.needsUpdate = true;
  context.particleGeometry.attributes.color.needsUpdate = true;
}

function renderSpectralFieldLayer(context: SpectralLayerContext, layer: VisualLayer, frame: LayerFrame, now: number, index: number) {
  context.group.visible = layer.enabled && layer.controls.opacity > 0;
  context.material.opacity = layer.controls.opacity;
  context.material.size = 0.035 * (layer.controls.pointSize ?? 1);
  if (!context.group.visible) {
    return;
  }
  context.group.rotation.y += 0.0015 * layer.controls.motionAmount + frame.high * 0.003;
  context.group.rotation.x = Math.sin(now * 0.00018 + index) * 0.24 * layer.controls.motionAmount;
  context.group.position.z = -0.6 - index * 0.08;

  const color = new THREE.Color();
  const liveCount = Math.floor(context.seeds.length * (layer.controls.density ?? 1));
  context.seeds.forEach((seed, pointIndex) => {
    if (pointIndex > liveCount) {
      context.positions[pointIndex * 3] = 999;
      context.positions[pointIndex * 3 + 1] = 999;
      context.positions[pointIndex * 3 + 2] = 999;
      return;
    }
    const bandValue = seed.band === 0 ? frame.low : seed.band === 1 ? frame.mid : frame.high;
    const pulse = 0.35 + bandValue * 2.4 * layer.controls.scaleAmount + frame.onset * 0.8;
    const angle = seed.angle + now * 0.00016 * layer.controls.motionAmount * (seed.band + 1);
    const yWave = Math.sin(seed.drift + now * 0.001 + frame.spectralCentroid * 3) * (0.25 + frame.mid * 1.1);
    const radius = seed.radius * pulse;
    context.positions[pointIndex * 3] = Math.cos(angle) * radius;
    context.positions[pointIndex * 3 + 1] = yWave + (seed.band - 1) * 0.62;
    context.positions[pointIndex * 3 + 2] = Math.sin(angle) * radius * (0.45 + frame.spectralCentroid);
    color.setHSL(wrap01(frame.hue + seed.band * 0.12 * layer.controls.colorAmount + seed.radius * 0.015), 0.78, 0.42 + bandValue * 0.34);
    context.colors[pointIndex * 3] = color.r;
    context.colors[pointIndex * 3 + 1] = color.g;
    context.colors[pointIndex * 3 + 2] = color.b;
  });

  context.geometry.attributes.position.needsUpdate = true;
  context.geometry.attributes.color.needsUpdate = true;
}

function renderChromaConstellationLayer(
  context: ChromaLayerContext,
  layer: VisualLayer,
  frame: LayerFrame,
  features: AudioFeatures,
  dt: number,
  now: number,
  index: number
) {
  context.group.visible = layer.enabled && layer.controls.opacity > 0;
  context.lineMaterial.opacity = layer.controls.opacity * (0.28 + features.chordConfidence * 0.58);
  context.particleMaterial.opacity = layer.controls.opacity;
  if (!context.group.visible) {
    return;
  }

  const chordClasses = getChordPitchClasses(features);
  const chordSet = new Set(chordClasses);
  const color = new THREE.Color();
  const qualityScale = getChordQualityScale(features.chordQuality);
  context.group.position.set((index - 1) * 0.34, 0, -0.2 - index * 0.06);
  context.group.rotation.z += dt * (0.08 + frame.vibratoRate * 0.8 + Math.abs(features.bendCents) / 480) * (layer.controls.orbitSpeed ?? layer.controls.motionAmount);
  context.group.rotation.x = Math.sin(now * 0.00022 + index) * 0.16 * layer.controls.motionAmount;
  context.group.scale.setScalar((0.92 + frame.rms * 0.34) * qualityScale);

  context.nodes.forEach((node, pitchClass) => {
    const chroma = clamp01(features.chroma[pitchClass] ?? 0);
    const active = chroma > 0.18;
    const inChord = chordSet.has(pitchClass);
    const angle = (pitchClass / 12) * Math.PI * 2 - Math.PI / 2;
    const radius = 2.0 + chroma * 0.55 * (layer.controls.nodeScale ?? layer.controls.scaleAmount) + (inChord ? 0.18 * (layer.controls.chordTension ?? 1) : 0);
    const z = Math.sin(now * 0.0016 + pitchClass) * frame.vibratoDepth * 0.18 + chroma * frame.brightness * 0.55;
    node.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
    node.scale.setScalar(0.72 + chroma * 2.2 + (inChord ? 0.55 : 0));
    const material = context.nodeMaterials[pitchClass];
    material.opacity = layer.controls.opacity * (active ? 1 : 0.42);
    material.color.setHSL(wrap01(pitchClass / 12 + frame.hue * 0.08), 0.72 + frame.brightness * 0.18, 0.28 + chroma * 0.38 + (inChord ? 0.12 : 0));
    material.emissive.setHSL(wrap01(pitchClass / 12 + frame.hue * 0.08), 0.74, 0.04 + chroma * 0.3 + (inChord ? 0.16 : 0));
    material.emissiveIntensity = 0.35 + chroma * 1.8 + frame.attack * 0.8;
  });

  updateChordLines(context, chordClasses, features.chordConfidence, color);

  if (frame.attack > 0.18 || frame.onset > 0.32) {
    spawnChromaParticles(context, features.chroma, frame);
  }
  updateParticles(context.particles, context.particlePositions, context.particleColors, dt, frame);
  context.particleGeometry.attributes.position.needsUpdate = true;
  context.particleGeometry.attributes.color.needsUpdate = true;
}

function renderGuitarGlyphLayer(
  context: GuitarGlyphLayerContext,
  layer: VisualLayer,
  frame: LayerFrame,
  features: AudioFeatures,
  dt: number,
  now: number,
  index: number
) {
  context.group.visible = layer.enabled && layer.controls.opacity > 0;
  context.stringMaterial.opacity = layer.controls.opacity * (0.38 + (features.harmonicRatio ?? 0) * 0.32);
  context.spectrumMaterial.opacity = layer.controls.opacity * 0.72;
  context.particleMaterial.opacity = layer.controls.opacity;
  if (!context.group.visible) {
    return;
  }

  const technique = features.guitarTechnique ?? 'idle';
  const voicing = Array.isArray(features.voicing) ? features.voicing : [];
  const logSpectrum = Array.isArray(features.logSpectrum) ? features.logSpectrum : [];
  const eventBoost = Array.isArray(features.guitarEvents) ? features.guitarEvents.reduce((max, event) => Math.max(max, event.strength), 0) : 0;
  context.group.position.set((index - 1) * 0.42, -0.15, -0.4 - index * 0.06);
  context.group.rotation.x = -0.22 * (layer.controls.fretboardTilt ?? 1) + Math.sin(now * 0.00022 + index) * 0.08 * layer.controls.motionAmount;
  context.group.rotation.y = Math.sin(now * 0.00018 + features.bendCents * 0.002) * 0.18 * layer.controls.motionAmount;
  context.group.scale.setScalar(0.92 + frame.rms * 0.18 + (features.guitarTechniqueConfidence ?? 0) * 0.08);

  context.fretBars.forEach((bar, fret) => {
    const material = bar.material as THREE.MeshStandardMaterial;
    material.opacity = layer.controls.opacity * (fret === 0 || fret === 12 ? 0.72 : 0.42);
    material.emissive.setHSL(frame.hue, 0.55, fret === features.fretNumber ? 0.16 + frame.attack * 0.22 : 0.02);
  });

  context.noteNodes.forEach((node, slot) => {
    const candidate = voicing[slot];
    const material = context.noteMaterials[slot];
    if (!candidate) {
      material.opacity += (0 - material.opacity) * 0.18;
      node.scale.setScalar(0.01);
      return;
    }
    const x = fretToX(candidate.fretNumber, layer.controls.fretSpan ?? 12);
    const y = stringToY(candidate.stringNumber);
    const confidence = clamp01(candidate.confidence);
    const active = features.stringNumber === candidate.stringNumber || confidence > 0.5;
    node.position.set(x, y, 0.08 + confidence * 0.2 + (active ? frame.onset * 0.24 : 0));
    node.scale.setScalar(0.75 + confidence * 1.45 + (active ? frame.attack * 0.9 : 0));
    const hue = wrap01((candidate.pitchClass ?? 0) / 12 + frame.hue * 0.08);
    material.opacity = layer.controls.opacity * (0.48 + confidence * 0.52);
    material.color.setHSL(hue, 0.72 + frame.brightness * 0.18, 0.36 + confidence * 0.28);
    material.emissive.setHSL(hue, 0.76, 0.08 + confidence * 0.28 * (layer.controls.noteGlow ?? 1) + eventBoost * 0.22);
    material.emissiveIntensity = 0.6 + (confidence * 1.6 + frame.attack * 1.2) * (layer.controls.noteGlow ?? 1);
  });

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  for (let bin = 0; bin < 36; bin += 1) {
    const value = clamp01(logSpectrum[bin] ?? 0);
    const x = -2.55 + bin * (5.1 / 35);
    const y = -1.72 - value * 0.42;
    const scaleY = 0.04 + value * 0.82 * (layer.controls.spectrumHeight ?? layer.controls.scaleAmount);
    matrix.compose(
      new THREE.Vector3(x, y, -0.05),
      new THREE.Quaternion(),
      new THREE.Vector3(1, scaleY, 1)
    );
    context.spectrum.setMatrixAt(bin, matrix);
    color.setHSL(wrap01(frame.hue + bin / 72), 0.72, 0.22 + value * 0.48);
    context.spectrum.setColorAt(bin, color);
  }
  context.spectrum.instanceMatrix.needsUpdate = true;
  if (context.spectrum.instanceColor) {
    context.spectrum.instanceColor.needsUpdate = true;
  }

  if (Array.isArray(features.guitarEvents)) {
    features.guitarEvents.forEach((event) => {
      if (context.seenEventIds.has(event.id)) {
        return;
      }
      context.seenEventIds.add(event.id);
      if (context.seenEventIds.size > 128) {
        context.seenEventIds = new Set(Array.from(context.seenEventIds).slice(-96));
      }
      spawnGlyphEventParticles(context, event.stringNumber ?? features.stringNumber, event.fretNumber ?? features.fretNumber, event.strength, frame, technique, layer.controls.fretSpan ?? 12);
    });
  }

  updateParticles(context.eventParticles, context.particlePositions, context.particleColors, dt, frame);
  context.particleGeometry.attributes.position.needsUpdate = true;
  context.particleGeometry.attributes.color.needsUpdate = true;
}

function renderStringResonatorLayer(
  context: StringResonatorLayerContext,
  layer: VisualLayer,
  frame: LayerFrame,
  features: AudioFeatures,
  dt: number,
  now: number,
  index: number
) {
  context.group.visible = layer.enabled && layer.controls.opacity > 0;
  context.material.opacity = layer.controls.opacity * (0.34 + frame.rms * 0.56 + clamp01(features.harmonicRatio ?? 0) * 0.22);
  if (!context.group.visible) {
    return;
  }

  const events = Array.isArray(features.guitarEvents) ? features.guitarEvents : [];
  events.forEach((event) => {
    if (context.seenEventIds.has(event.id)) {
      return;
    }
    context.seenEventIds.add(event.id);
    if (context.seenEventIds.size > 128) {
      context.seenEventIds = new Set(Array.from(context.seenEventIds).slice(-96));
    }
    const stringNumber = event.stringNumber ?? features.stringNumber;
    if (typeof stringNumber === 'number') {
      const stringIndex = 6 - Math.max(1, Math.min(6, Math.round(stringNumber)));
      context.stringEnergy[stringIndex] = Math.max(context.stringEnergy[stringIndex], clamp01(event.strength));
    }
  });

  const activeString = typeof features.stringNumber === 'number' ? 6 - Math.max(1, Math.min(6, Math.round(features.stringNumber))) : -1;
  const voicing = Array.isArray(features.voicing) ? features.voicing : [];
  const color = new THREE.Color();
  const segments = 56;
  let offset = 0;
  const visibleStrings = Math.max(1, Math.min(6, Math.round(layer.controls.stringCount ?? 6)));
  context.group.position.set((index - 1) * 0.28, -0.05, -0.15 - index * 0.08);
  context.group.rotation.x = -0.12 + Math.sin(now * 0.00018 + index) * 0.1 * layer.controls.motionAmount;
  context.group.rotation.y = Math.sin(now * 0.00015 + features.bendCents * 0.002) * 0.22 * layer.controls.motionAmount;
  context.group.scale.setScalar(0.92 + frame.low * 0.18 + clamp01(features.guitarTechniqueConfidence ?? 0) * 0.1);

  for (let stringIndex = 0; stringIndex < 6; stringIndex += 1) {
    if (stringIndex >= visibleStrings) {
      for (let hidden = 0; hidden < (segments - 1) * 2; hidden += 1) {
        context.positions[offset] = 999;
        context.positions[offset + 1] = 999;
        context.positions[offset + 2] = 999;
        context.colors[offset] = 0;
        context.colors[offset + 1] = 0;
        context.colors[offset + 2] = 0;
        offset += 3;
      }
      continue;
    }
    const stringNumber = 6 - stringIndex;
    const voicingEnergy = voicing
      .filter((candidate) => candidate.stringNumber === stringNumber)
      .reduce((max, candidate) => Math.max(max, clamp01(candidate.confidence)), 0);
    const directEnergy = activeString === stringIndex ? clamp01(features.pitchConfidence ?? 0) : 0;
    const energy = Math.max(context.stringEnergy[stringIndex], voicingEnergy, directEnergy * 0.8);
    const muteDamp = 1 - clamp01(features.muteAmount ?? 0) * 0.55;
    const y = 1.12 - stringIndex * 0.44;
    const zBase = (stringIndex - 2.5) * 0.06;
    const bend = clamp01(Math.abs(features.bendCents ?? 0) / 180) * (layer.controls.bendSensitivity ?? 1);
    const waveAmp = (0.025 + energy * 0.34 + frame.vibratoDepth * 0.22 + bend * 0.18) * (layer.controls.waveDepth ?? layer.controls.scaleAmount) * muteDamp;
    const frequency = 1.4 + stringIndex * 0.18 + frame.vibratoRate * 3.2 + clamp01(features.pickNoise ?? 0) * 1.4;
    const hue = wrap01(frame.hue + stringIndex * 0.065 + voicingEnergy * 0.08);
    context.stringEnergy[stringIndex] *= Math.max(0.72, 0.98 - dt * (1.4 / (layer.controls.resonanceDecay ?? 1) + clamp01(features.muteAmount ?? 0) * 3));

    for (let segment = 0; segment < segments - 1; segment += 1) {
      for (let endpoint = 0; endpoint < 2; endpoint += 1) {
        const point = segment + endpoint;
        const pct = point / (segments - 1);
        const x = -2.9 + pct * 5.8;
        const fretFocus = typeof features.fretNumber === 'number' ? features.fretNumber / 12 : 0.5;
        const envelope = Math.sin(Math.PI * pct) * (0.55 + Math.exp(-Math.abs(pct - fretFocus) * 6) * 0.45);
        const phase = now * 0.004 * layer.controls.motionAmount + point * frequency + stringIndex;
        const z = zBase + Math.sin(phase) * waveAmp * envelope + Math.cos(phase * 0.43) * waveAmp * 0.35;
        context.positions[offset] = x;
        context.positions[offset + 1] = y + Math.cos(phase * 0.6) * waveAmp * 0.28;
        context.positions[offset + 2] = z;
        color.setHSL(hue, 0.66 + energy * 0.24, 0.28 + energy * 0.42 + (activeString === stringIndex ? frame.attack * 0.18 : 0));
        context.colors[offset] = color.r;
        context.colors[offset + 1] = color.g;
        context.colors[offset + 2] = color.b;
        offset += 3;
      }
    }
  }

  context.geometry.attributes.position.needsUpdate = true;
  context.geometry.attributes.color.needsUpdate = true;
}

function renderTechniqueShardLayer(
  context: TechniqueShardLayerContext,
  layer: VisualLayer,
  frame: LayerFrame,
  features: AudioFeatures,
  dt: number,
  now: number,
  index: number
) {
  context.group.visible = layer.enabled && layer.controls.opacity > 0;
  context.material.opacity = layer.controls.opacity * (0.52 + clamp01(features.guitarTechniqueConfidence ?? 0) * 0.38);
  context.ringMaterial.opacity = layer.controls.opacity * (0.22 + frame.onset * 0.42 + clamp01(features.chordConfidence ?? 0) * 0.18);
  if (!context.group.visible) {
    return;
  }

  const techniqueIntensity = getTechniqueIntensity(features);
  const pick = clamp01(features.pickNoise ?? 0);
  const mute = clamp01(features.muteAmount ?? 0);
  const bend = clamp01(Math.abs(features.bendCents ?? 0) / 180);
  const harmonic = clamp01(features.harmonicRatio ?? 0);
  const confidence = clamp01(features.guitarTechniqueConfidence ?? 0);
  const shardColor = new THREE.Color();
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  context.group.position.set((index - 1) * 0.34, 0.06, -0.28 - index * 0.08);
  context.group.rotation.y += dt * (0.11 + techniqueIntensity * 0.46 + bend * 0.7) * layer.controls.motionAmount;
  context.group.rotation.x = Math.sin(now * 0.0002 + index) * 0.2 * layer.controls.motionAmount;

  context.seeds.forEach((seed, shardIndex) => {
    if (shardIndex > context.seeds.length * (layer.controls.shardCount ?? 1)) {
      matrix.compose(new THREE.Vector3(999, 999, 999), quaternion, scale.setScalar(0.001));
      context.shards.setMatrixAt(shardIndex, matrix);
      return;
    }
    const techniqueMatch = techniqueIntensity * (0.55 + seed.techniqueBias * 0.55);
    const radius = seed.radius * (0.62 + harmonic * 0.42 + frame.mid * 0.28) * (layer.controls.scatter ?? 1);
    const spin = now * 0.00025 * layer.controls.motionAmount * (1 + seed.techniqueBias * 2.2 + pick);
    const angle = seed.angle + spin + bend * Math.sin(seed.phase + now * 0.003) * 0.8;
    const rough = pick * Math.sin(seed.phase * 2.1 + now * 0.008) * 0.34;
    const position = new THREE.Vector3(
      Math.cos(angle) * radius + rough,
      seed.height * (0.76 + frame.low * 0.2) + Math.sin(seed.phase + now * 0.0017) * (0.14 + frame.vibratoDepth * 0.55),
      Math.sin(angle) * radius * (0.58 + frame.brightness * 0.42) - mute * 0.34
    );
    quaternion.setFromEuler(new THREE.Euler(
      angle * 0.2 + frame.vibratoDepth * 1.5,
      angle + now * 0.0007,
      seed.phase + techniqueMatch * 2.4
    ));
    const shardScale = (0.42 + frame.rms * 1.5 + techniqueMatch * 1.4 + frame.attack * 1.1) * (layer.controls.fracture ?? layer.controls.scaleAmount);
    scale.set(
      0.6 + pick * 1.8 + bend * 1.2,
      shardScale * (0.55 + seed.techniqueBias * 1.7),
      0.65 + mute * 1.4 + harmonic * 0.45
    );
    matrix.compose(position, quaternion, scale);
    context.shards.setMatrixAt(shardIndex, matrix);
    const hue = wrap01(frame.hue + getTechniqueHue(features.guitarTechnique) + seed.techniqueBias * 0.08);
    shardColor.setHSL(hue, 0.62 + confidence * 0.26, 0.28 + techniqueMatch * 0.42 + frame.attack * 0.14);
    context.shards.setColorAt(shardIndex, shardColor);
  });
  context.shards.instanceMatrix.needsUpdate = true;
  if (context.shards.instanceColor) {
    context.shards.instanceColor.needsUpdate = true;
  }
  context.material.emissive.setHSL(wrap01(frame.hue + getTechniqueHue(features.guitarTechnique)), 0.7, 0.05 + techniqueIntensity * 0.25 + frame.attack * 0.12);
  context.material.emissiveIntensity = 0.55 + techniqueIntensity * 1.9 + frame.onset * 1.2;

  updateTechniqueShardRings(context, features, frame);
}

function updateChordLines(context: ChromaLayerContext, chordClasses: number[], confidence: number, color: THREE.Color) {
  let segment = 0;
  const classes = chordClasses.length >= 2 ? chordClasses : [];
  for (let index = 0; index < classes.length; index += 1) {
    const from = context.nodes[classes[index]];
    const to = context.nodes[classes[(index + 1) % classes.length]];
    const offset = segment * 6;
    context.linePositions[offset] = from.position.x;
    context.linePositions[offset + 1] = from.position.y;
    context.linePositions[offset + 2] = from.position.z;
    context.linePositions[offset + 3] = to.position.x;
    context.linePositions[offset + 4] = to.position.y;
    context.linePositions[offset + 5] = to.position.z;
    color.setHSL(classes[index] / 12, 0.82, 0.42 + confidence * 0.26);
    context.lineColors[offset] = color.r;
    context.lineColors[offset + 1] = color.g;
    context.lineColors[offset + 2] = color.b;
    context.lineColors[offset + 3] = color.r;
    context.lineColors[offset + 4] = color.g;
    context.lineColors[offset + 5] = color.b;
    segment += 1;
  }

  for (let index = segment * 6; index < context.linePositions.length; index += 6) {
    context.linePositions[index] = 999;
    context.linePositions[index + 1] = 999;
    context.linePositions[index + 2] = 999;
    context.linePositions[index + 3] = 999;
    context.linePositions[index + 4] = 999;
    context.linePositions[index + 5] = 999;
  }
  context.lineGeometry.attributes.position.needsUpdate = true;
  context.lineGeometry.attributes.color.needsUpdate = true;
}

function updateTechniqueShardRings(context: TechniqueShardLayerContext, features: AudioFeatures, frame: LayerFrame) {
  const color = new THREE.Color();
  const chroma = Array.isArray(features.chroma) ? features.chroma : [];
  let segment = 0;
  for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
    const value = clamp01(chroma[pitchClass] ?? 0);
    if (value < 0.18) {
      continue;
    }
    const fromAngle = (pitchClass / 12) * Math.PI * 2;
    const toAngle = ((pitchClass + 1) / 12) * Math.PI * 2;
    const radius = 1.2 + value * 1.25 + clamp01(features.chordConfidence ?? 0) * 0.45;
    const y = -1.1 + value * 0.46 + frame.vibratoDepth * 0.3;
    const offset = segment * 6;
    context.ringPositions[offset] = Math.cos(fromAngle) * radius;
    context.ringPositions[offset + 1] = y;
    context.ringPositions[offset + 2] = Math.sin(fromAngle) * radius * 0.72;
    context.ringPositions[offset + 3] = Math.cos(toAngle) * radius;
    context.ringPositions[offset + 4] = y;
    context.ringPositions[offset + 5] = Math.sin(toAngle) * radius * 0.72;
    color.setHSL(wrap01(pitchClass / 12 + frame.hue * 0.06), 0.82, 0.34 + value * 0.38);
    context.ringColors[offset] = color.r;
    context.ringColors[offset + 1] = color.g;
    context.ringColors[offset + 2] = color.b;
    context.ringColors[offset + 3] = color.r;
    context.ringColors[offset + 4] = color.g;
    context.ringColors[offset + 5] = color.b;
    segment += 1;
  }

  for (let index = segment * 6; index < context.ringPositions.length; index += 6) {
    context.ringPositions[index] = 999;
    context.ringPositions[index + 1] = 999;
    context.ringPositions[index + 2] = 999;
    context.ringPositions[index + 3] = 999;
    context.ringPositions[index + 4] = 999;
    context.ringPositions[index + 5] = 999;
  }
  context.ringGeometry.attributes.position.needsUpdate = true;
  context.ringGeometry.attributes.color.needsUpdate = true;
}

function spawnChromaParticles(context: ChromaLayerContext, chroma: number[], frame: LayerFrame) {
  const maxParticles = context.particlePositions.length / 3;
  chroma.forEach((value, pitchClass) => {
    if (value < 0.22) {
      return;
    }
    const count = Math.min(5, Math.ceil(value * (1 + frame.attack * 5)));
    const source = context.nodes[pitchClass].position;
    for (let i = 0; i < count; i += 1) {
      if (context.particles.length >= maxParticles) {
        context.particles.shift();
      }
      const angle = (pitchClass / 12) * Math.PI * 2 + (Math.random() - 0.5) * 0.8;
      const speed = 0.45 + value * 1.6 + frame.attack * 2.2;
      context.particles.push({
        position: source.clone(),
        velocity: new THREE.Vector3(Math.cos(angle) * speed, Math.sin(angle) * speed, (Math.random() - 0.5) * speed),
        life: 0.55 + Math.random() * 0.7,
        hue: pitchClass / 12
      });
    }
  });
}

function spawnGlyphEventParticles(
  context: GuitarGlyphLayerContext,
  stringNumber: number | null | undefined,
  fretNumber: number | null | undefined,
  strength: number,
  frame: LayerFrame,
  technique: AudioFeatures['guitarTechnique'],
  fretSpan = 12
) {
  const maxParticles = context.particlePositions.length / 3;
  const source = new THREE.Vector3(
    fretToX(fretNumber ?? 0, fretSpan),
    stringToY(stringNumber ?? 3),
    0.2
  );
  const count = Math.floor(8 + clamp01(strength) * 34 + (technique === 'strum' || technique === 'scrape' ? 18 : 0));
  for (let index = 0; index < count; index += 1) {
    if (context.eventParticles.length >= maxParticles) {
      context.eventParticles.shift();
    }
    const angle = Math.random() * Math.PI * 2;
    const lateral = technique === 'strum' || technique === 'scrape' ? 1.8 : 0.8;
    const speed = 0.35 + clamp01(strength) * 3.2;
    context.eventParticles.push({
      position: source.clone(),
      velocity: new THREE.Vector3(
        Math.cos(angle) * speed * lateral,
        Math.sin(angle) * speed * 0.42,
        (Math.random() - 0.2) * speed
      ),
      life: 0.5 + Math.random() * 0.9,
      hue: wrap01(frame.hue + (Math.random() - 0.5) * 0.16)
    });
  }
}

function stringToY(stringNumber: number): number {
  const clamped = Math.max(1, Math.min(6, Math.round(stringNumber)));
  return 1.1 - (6 - clamped) * 0.44;
}

function fretToX(fretNumber: number, fretSpan = 12): number {
  const span = Math.max(5, Math.min(24, fretSpan));
  const clamped = Math.max(0, Math.min(span, fretNumber));
  return -2.35 + (clamped / span) * 4.68;
}

function getStringEnergy(features: AudioFeatures, stringNumber: number): number {
  const voicingEnergy = Array.isArray(features.voicing)
    ? features.voicing
        .filter((candidate) => candidate.stringNumber === stringNumber)
        .reduce((max, candidate) => Math.max(max, clamp01(candidate.confidence)), 0)
    : 0;
  const directEnergy = features.stringNumber === stringNumber ? clamp01(features.pitchConfidence) : 0;
  const eventEnergy = Array.isArray(features.guitarEvents)
    ? features.guitarEvents
        .filter((event) => event.stringNumber === stringNumber)
        .reduce((max, event) => Math.max(max, clamp01(event.strength) * Math.max(0, 1 - Math.max(0, features.t - event.t) / 1.2)), 0)
    : 0;
  return Math.max(voicingEnergy, directEnergy, eventEnergy);
}

function getTechniqueIntensity(features: AudioFeatures): number {
  const confidence = clamp01(features.guitarTechniqueConfidence ?? 0);
  const expressive = Math.max(
    clamp01(features.pickNoise ?? 0),
    clamp01(features.muteAmount ?? 0),
    clamp01(features.vibratoDepth ?? 0),
    clamp01(Math.abs(features.bendCents ?? 0) / 180),
    clamp01(features.chordConfidence ?? 0),
    clamp01(features.harmonicRatio ?? 0)
  );
  return clamp01(confidence * 0.55 + expressive * 0.45);
}

function getTechniqueHue(technique: AudioFeatures['guitarTechnique']): number {
  switch (technique) {
    case 'palm_mute':
      return 0.03;
    case 'scrape':
    case 'noise':
      return 0.11;
    case 'strum':
      return 0.2;
    case 'bend':
      return 0.52;
    case 'vibrato':
      return 0.68;
    case 'single_note':
      return 0.82;
    case 'sustain':
      return 0.9;
    default:
      return 0;
  }
}

function techniqueHueOffset(type: AudioFeatures['guitarEvents'][number]['type']): number {
  switch (type) {
    case 'pluck':
    case 'note_on':
      return 35;
    case 'strum':
    case 'chord_change':
      return 96;
    case 'bend':
      return 190;
    case 'vibrato':
      return 245;
    case 'mute':
      return 18;
    case 'noise':
      return 310;
    default:
      return 0;
  }
}

function eventLaneIndex(type: AudioFeatures['guitarEvents'][number]['type']): number {
  switch (type) {
    case 'pluck':
    case 'note_on':
      return 0;
    case 'mute':
      return 1;
    case 'strum':
    case 'chord_change':
      return 2;
    case 'vibrato':
      return 3;
    case 'bend':
      return 4;
    case 'noise':
      return 5;
    default:
      return 0;
  }
}

function getChordPitchClasses(features: AudioFeatures): number[] {
  const root = pitchClassFromName(features.chordRoot);
  if (root === null || !features.chordQuality || features.chordQuality === 'unknown' || features.chordConfidence < 0.2) {
    return [];
  }
  const intervals: Record<string, number[]> = {
    major: [0, 4, 7],
    minor: [0, 3, 7],
    power: [0, 7],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7],
    major7: [0, 4, 7, 11],
    minor7: [0, 3, 7, 10],
    dominant7: [0, 4, 7, 10],
    add9: [0, 2, 4, 7],
    dyad: [0, 5]
  };
  return (intervals[features.chordQuality] ?? []).map((interval) => (root + interval) % 12);
}

function pitchClassFromName(note: string | null): number | null {
  if (!note) {
    return null;
  }
  const names: Record<string, number> = {
    C: 0,
    'C#': 1,
    D: 2,
    'D#': 3,
    E: 4,
    F: 5,
    'F#': 6,
    G: 7,
    'G#': 8,
    A: 9,
    'A#': 10,
    B: 11
  };
  return names[note] ?? null;
}

function getChordQualityScale(quality: AudioFeatures['chordQuality']): number {
  switch (quality) {
    case 'minor':
      return 0.94;
    case 'power':
      return 1.08;
    case 'sus2':
    case 'sus4':
      return 1.03;
    default:
      return 1;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function createRenderer(): THREE.WebGLRenderer {
  return new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
}

function createChromaticGeometries(): THREE.BufferGeometry[] {
  return [
    new THREE.IcosahedronGeometry(1.2, 4),
    new THREE.BoxGeometry(1.65, 1.65, 1.65, 3, 3, 3),
    new THREE.TorusGeometry(0.9, 0.23, 24, 96),
    new THREE.ConeGeometry(1.05, 1.95, 6, 2),
    new THREE.TorusKnotGeometry(0.82, 0.22, 180, 18),
    new THREE.OctahedronGeometry(1.35, 3),
    new THREE.CapsuleGeometry(0.62, 1.25, 12, 32),
    new THREE.TetrahedronGeometry(1.5, 2),
    new THREE.DodecahedronGeometry(1.25, 2),
    new THREE.CylinderGeometry(0.85, 0.85, 1.75, 7, 2),
    new THREE.SphereGeometry(1.15, 24, 12, 0, Math.PI * 2, 0.22, Math.PI - 0.44),
    new THREE.TorusKnotGeometry(0.78, 0.18, 160, 14, 3, 5)
  ];
}

function getPitchClassIndex(pitchHz: number | null): number {
  if (!pitchHz || pitchHz <= 0) {
    return 0;
  }

  const midi = Math.round(69 + 12 * Math.log2(pitchHz / 440));
  return ((midi % 12) + 12) % 12;
}

function getSideScrollerPitchY(pitchHz: number | null | undefined, spectralCentroid: number, canvasHeight: number): number {
  if (pitchHz && pitchHz > 0) {
    const midi = 69 + 12 * Math.log2(pitchHz / 440);
    return getSideScrollerMidiY(midi, canvasHeight);
  }
  const top = canvasHeight * 0.08;
  const bottom = canvasHeight * 0.92;
  return bottom - clamp01(spectralCentroid) * (bottom - top);
}

function getSideScrollerMidiY(midi: number, canvasHeight: number): number {
  const top = canvasHeight * 0.08;
  const bottom = canvasHeight * 0.92;
  const lowMidi = 40;
  const highMidi = 84;
  const pct = Math.max(0, Math.min(1, (midi - lowMidi) / (highMidi - lowMidi)));
  return bottom - pct * (bottom - top);
}

function getVoicingCandidateMidi(stringNumber: number, fretNumber: number): number {
  const openStringMidi: Record<number, number> = {
    1: 64,
    2: 59,
    3: 55,
    4: 50,
    5: 45,
    6: 40
  };
  return (openStringMidi[Math.max(1, Math.min(6, Math.round(stringNumber)))] ?? 40) + Math.max(0, Math.min(24, Math.round(fretNumber)));
}

function spawnParticles(particles: Particle[], maxParticles: number, frame: LayerFrame, burst = 1) {
  const count = Math.floor((8 + frame.onset * 34 + frame.high * 18) * burst);
  for (let i = 0; i < count; i += 1) {
    if (particles.length >= maxParticles) {
      particles.shift();
    }

    const angle = Math.random() * Math.PI * 2;
    const speed = 0.6 + frame.peak * 5 + Math.random() * frame.high * 3;
    particles.push({
      position: new THREE.Vector3(0, 0, 0),
      velocity: new THREE.Vector3(Math.cos(angle) * speed, (Math.random() - 0.2) * speed, Math.sin(angle) * speed),
      life: 0.7 + Math.random() * 1.2,
      hue: wrap01(frame.hue + (Math.random() - 0.5) * 0.18)
    });
  }
}

function updateParticles(particles: Particle[], positions: Float32Array, colors: Float32Array, dt: number, frame: LayerFrame) {
  const color = new THREE.Color();
  particles.forEach((particle, index) => {
    particle.life -= dt * (0.55 + frame.high);
    particle.velocity.multiplyScalar(0.985 - frame.low * 0.04);
    particle.velocity.y += dt * (-0.2 + frame.mid * 0.75);
    particle.position.addScaledVector(particle.velocity, dt);
    positions[index * 3] = particle.position.x;
    positions[index * 3 + 1] = particle.position.y;
    positions[index * 3 + 2] = particle.position.z;
    color.setHSL(particle.hue, 0.82, 0.5 + Math.max(0, particle.life) * 0.22);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  });

  for (let index = particles.length; index < positions.length / 3; index += 1) {
    positions[index * 3] = 999;
    positions[index * 3 + 1] = 999;
    positions[index * 3 + 2] = 999;
    colors[index * 3] = 0;
    colors[index * 3 + 1] = 0;
    colors[index * 3 + 2] = 0;
  }

  for (let index = particles.length - 1; index >= 0; index -= 1) {
    if (particles[index].life <= 0) {
      particles.splice(index, 1);
    }
  }
}

function createEmptyFrame(): LayerFrame {
  return {
    rms: 0,
    peak: 0,
    low: 0,
    mid: 0,
    high: 0,
    spectralCentroid: 0,
    spectralFlux: 0,
    brightness: 0,
    noisiness: 0,
    attack: 0,
    vibratoDepth: 0,
    vibratoRate: 0,
    onset: 0,
    noteStability: 0,
    gateOpen: false,
    hue: 0.08
  };
}

function getFeatureHue(features: AudioFeatures): number {
  return features.pitchHz && features.pitchConfidence > 0.35
    ? wrap01(Math.log2(features.pitchHz / 82.41))
    : wrap01(0.08 + features.spectralCentroid * 0.52);
}

function lerpHue(current: number, target: number, amount: number): number {
  const delta = ((target - current + 0.5) % 1) - 0.5;
  return wrap01(current + delta * amount);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number) {
  return Math.max(-1, Math.min(1, value));
}

function wrap01(value: number) {
  return ((value % 1) + 1) % 1;
}

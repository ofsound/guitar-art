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
  texture: THREE.CanvasTexture;
  material: THREE.MeshBasicMaterial;
  plane: THREE.Mesh;
  trailX: number;
  trailY: number;
  seed: number;
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

type LayerContext = TwoDLayerContext | FormsLayerContext | SpectralLayerContext | ChromaLayerContext;

type RecordingState = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  frameCount: number;
  startedAt: number;
};

export type VisualRecordingResult = {
  dataUrl: string;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
};

export type VisualSynthHandle = {
  startRecording: () => void;
  stopRecording: () => VisualRecordingResult | null;
};

export const VisualSynth = forwardRef<VisualSynthHandle, {
  featuresRef: React.MutableRefObject<AudioFeatures>;
  layers: VisualLayer[];
}>(function VisualSynth({ featuresRef, layers }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const layersRef = useRef(layers);
  const startRecordingRef = useRef<() => void>(() => undefined);
  const stopRecordingRef = useRef<() => VisualRecordingResult | null>(() => null);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  useImperativeHandle(
    ref,
    () => ({
      startRecording: () => startRecordingRef.current(),
      stopRecording: () => stopRecordingRef.current()
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setClearColor(0x07090a, 1);
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
    let animation = 0;
    let last = performance.now();

    startRecordingRef.current = () => {
      const canvas = document.createElement('canvas');
      canvas.width = renderer.domElement.width;
      canvas.height = renderer.domElement.height;
      const context = canvas.getContext('2d', { alpha: false })!;
      context.fillStyle = '#07090a';
      context.fillRect(0, 0, canvas.width, canvas.height);
      recordingRef.current = {
        canvas,
        context,
        frameCount: 0,
        startedAt: performance.now()
      };
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

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      layerContexts.forEach((context) => {
        if (context.type === '2d') {
          resizeCanvasLayer(context, width, height);
        }
      });
    };
    resize();
    window.addEventListener('resize', resize);

    const animate = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const features = featuresRef.current;
      const activeLayers = layersRef.current;

      reconcileLayerContexts(scene, layerContexts, activeLayers, host.clientWidth, host.clientHeight);

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
          render2DLayer(context, layer, frame, dt, now, index);
        } else if (context.type === 'forms3d') {
          renderFormsLayer(context, layer, frame, features, dt, index);
        } else if (context.type === 'spectralField3d') {
          renderSpectralFieldLayer(context, layer, frame, now, index);
        } else {
          renderChromaConstellationLayer(context, layer, frame, features, dt, now, index);
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
      captureRecordingFrame(recordingRef.current, renderer.domElement);
      animation = requestAnimationFrame(animate);
    };

    animation = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animation);
      window.removeEventListener('resize', resize);
      startRecordingRef.current = () => undefined;
      stopRecordingRef.current = () => null;
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
    };
  }, [featuresRef]);

  return <div className="visual-host" ref={hostRef} />;
});

function reconcileLayerContexts(
  scene: THREE.Scene,
  contexts: Map<string, LayerContext>,
  layers: VisualLayer[],
  width: number,
  height: number
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

    const context = createLayerContext(scene, layer, width, height);
    contexts.set(layer.id, context);
    setLayerRenderOrder(context, index);
  });
}

function createLayerContext(scene: THREE.Scene, layer: VisualLayer, width: number, height: number): LayerContext {
  if (layer.mode === 'trails2d' || layer.mode === 'lineArt2d') {
    return create2DLayerContext(scene, layer, width, height);
  }
  if (layer.mode === 'forms3d') {
    return createFormsLayerContext(scene, layer);
  }
  if (layer.mode === 'chromaConstellation3d') {
    return createChromaLayerContext(scene, layer);
  }
  return createSpectralFieldLayerContext(scene, layer);
}

function create2DLayerContext(scene: THREE.Scene, layer: VisualLayer, width: number, height: number): TwoDLayerContext {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: true })!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity: layer.controls.opacity
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(18, 10), material);
  plane.position.set(0, 0, -2.8);
  scene.add(plane);

  const layerContext: TwoDLayerContext = {
    id: layer.id,
    mode: layer.mode,
    type: '2d',
    canvas,
    context,
    texture,
    material,
    plane,
    trailX: 0.5,
    trailY: 0.5,
    seed: Math.random() * 1000,
    smoothed: createEmptyFrame(),
    dispose: () => {
      scene.remove(plane);
      plane.geometry.dispose();
      material.dispose();
      texture.dispose();
    }
  };
  resizeCanvasLayer(layerContext, width, height);
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

function resizeCanvasLayer(layer: TwoDLayerContext, width: number, height: number) {
  const ratio = Math.min(window.devicePixelRatio, 2);
  const canvasWidth = Math.max(1, Math.floor(width * ratio));
  const canvasHeight = Math.max(1, Math.floor(height * ratio));
  if (layer.canvas.width === canvasWidth && layer.canvas.height === canvasHeight) {
    return;
  }
  layer.canvas.width = canvasWidth;
  layer.canvas.height = canvasHeight;
  layer.context.fillStyle = '#0a0e10';
  layer.context.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
  layer.texture.needsUpdate = true;
}

function setLayerRenderOrder(context: LayerContext, index: number) {
  if (context.type === '2d') {
    context.plane.renderOrder = index;
    context.plane.position.z = -3 + index * 0.025;
  } else {
    context.group.renderOrder = index;
    context.group.children.forEach((child) => {
      child.renderOrder = index;
    });
  }
}

function captureRecordingFrame(recording: RecordingState | null, source: HTMLCanvasElement) {
  if (!recording) {
    return;
  }
  recording.context.globalCompositeOperation = 'lighter';
  recording.context.globalAlpha = recording.frameCount === 0 ? 1 : 0.16;
  recording.context.drawImage(source, 0, 0, recording.canvas.width, recording.canvas.height);
  recording.context.globalAlpha = 1;
  recording.context.globalCompositeOperation = 'source-over';
  recording.frameCount += 1;
}

function hideLayerContext(context: LayerContext) {
  if (context.type === '2d') {
    context.plane.visible = false;
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

function render2DLayer(layerContext: TwoDLayerContext, layer: VisualLayer, frame: LayerFrame, dt: number, now: number, index: number) {
  layerContext.material.opacity = layer.enabled ? layer.controls.opacity : 0;
  layerContext.plane.visible = layer.enabled && layer.controls.opacity > 0;
  if (!layerContext.plane.visible) {
    return;
  }
  if (layer.mode === 'lineArt2d') {
    drawLineArt(layerContext, layer, frame, now, index);
  } else {
    drawTrails(layerContext, layer, frame, dt, now);
  }
  layerContext.texture.needsUpdate = true;
}

function drawTrails(layerContext: TwoDLayerContext, layer: VisualLayer, frame: LayerFrame, dt: number, now: number) {
  const { context, canvas } = layerContext;
  const fade = frame.gateOpen ? 0.018 - frame.rms * 0.008 : 0.032;
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
  const rings = 2 + Math.floor(frame.mid * 7);
  const points = 5 + Math.floor(frame.high * 10);
  const baseRadius = Math.min(canvas.width, canvas.height) * (0.08 + frame.low * 0.24 * layer.controls.scaleAmount);

  for (let ring = 0; ring < rings; ring += 1) {
    const radius = baseRadius * (1 + ring * 0.42) + frame.onset * 80;
    const phase = now * 0.00018 * layer.controls.motionAmount + ring * 0.6 + index * 0.35;
    const lightness = 46 + frame.rms * 34 + ring * 3;
    context.strokeStyle = `hsla(${Math.round(frame.hue * 360 + ring * 24 * layer.controls.colorAmount)}, ${62 + frame.high * 24}%, ${lightness}%, ${0.1 + frame.rms * 0.32})`;
    context.lineWidth = 0.8 + frame.rms * 6 + ring * 0.28;
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
    spawnParticles(context.particles, context.particlePositions.length / 3, frame);
  }
  updateParticles(context.particles, context.particlePositions, context.particleColors, dt, frame);
  context.particleGeometry.attributes.position.needsUpdate = true;
  context.particleGeometry.attributes.color.needsUpdate = true;
}

function renderSpectralFieldLayer(context: SpectralLayerContext, layer: VisualLayer, frame: LayerFrame, now: number, index: number) {
  context.group.visible = layer.enabled && layer.controls.opacity > 0;
  context.material.opacity = layer.controls.opacity;
  if (!context.group.visible) {
    return;
  }
  context.group.rotation.y += 0.0015 * layer.controls.motionAmount + frame.high * 0.003;
  context.group.rotation.x = Math.sin(now * 0.00018 + index) * 0.24 * layer.controls.motionAmount;
  context.group.position.z = -0.6 - index * 0.08;

  const color = new THREE.Color();
  context.seeds.forEach((seed, pointIndex) => {
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
  context.group.rotation.z += dt * (0.08 + frame.vibratoRate * 0.8 + Math.abs(features.bendCents) / 480) * layer.controls.motionAmount;
  context.group.rotation.x = Math.sin(now * 0.00022 + index) * 0.16 * layer.controls.motionAmount;
  context.group.scale.setScalar((0.92 + frame.rms * 0.34) * qualityScale);

  context.nodes.forEach((node, pitchClass) => {
    const chroma = clamp01(features.chroma[pitchClass] ?? 0);
    const active = chroma > 0.18;
    const inChord = chordSet.has(pitchClass);
    const angle = (pitchClass / 12) * Math.PI * 2 - Math.PI / 2;
    const radius = 2.0 + chroma * 0.55 * layer.controls.scaleAmount + (inChord ? 0.18 : 0);
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
    sus4: [0, 5, 7]
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

function createRenderer(): THREE.WebGLRenderer {
  return new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
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

function spawnParticles(particles: Particle[], maxParticles: number, frame: LayerFrame) {
  const count = Math.floor(8 + frame.onset * 34 + frame.high * 18);
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

function wrap01(value: number) {
  return ((value % 1) + 1) % 1;
}

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { AudioFeatures, LayerState } from '../shared/audio';

type Particle = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  hue: number;
};

export function VisualSynth({
  featuresRef,
  layers
}: {
  featuresRef: React.MutableRefObject<AudioFeatures>;
  layers: LayerState;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const layersRef = useRef(layers);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

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

    const trailCanvas = document.createElement('canvas');
    const trailContext = trailCanvas.getContext('2d', { alpha: true })!;
    const trailTexture = new THREE.CanvasTexture(trailCanvas);
    trailTexture.colorSpace = THREE.SRGBColorSpace;
    const trailPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 10),
      new THREE.MeshBasicMaterial({ map: trailTexture, transparent: true, depthWrite: false, opacity: 0.86 })
    );
    trailPlane.position.set(0, 0, -2.6);
    scene.add(trailPlane);

    const geometrySet = createChromaticGeometries();
    const harmonicMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.58, 0.82, 0.58),
      metalness: 0.22,
      roughness: 0.38,
      emissive: new THREE.Color(0x081014),
      emissiveIntensity: 0.5
    });
    const harmonicMesh = new THREE.Mesh(geometrySet[0], harmonicMaterial);
    scene.add(harmonicMesh);

    const particleGeometry = new THREE.BufferGeometry();
    const maxParticles = 320;
    const particlePositions = new Float32Array(maxParticles * 3);
    const particleColors = new Float32Array(maxParticles * 3);
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    particleGeometry.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
    const particleMaterial = new THREE.PointsMaterial({
      size: 0.045,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const particlePoints = new THREE.Points(particleGeometry, particleMaterial);
    scene.add(particlePoints);

    const key = new THREE.PointLight(0xb6fbff, 26, 30);
    key.position.set(3, 4, 5);
    scene.add(key);
    const fill = new THREE.PointLight(0xff7a45, 10, 25);
    fill.position.set(-3, -2, 4);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0x6c7880, 0.9));

    const particles: Particle[] = [];
    let animation = 0;
    let last = performance.now();
    let smoothedRms = 0;
    let lastGeometryMode = 0;
    let trailX = 0.5;
    let trailY = 0.5;

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      trailCanvas.width = Math.floor(width * Math.min(window.devicePixelRatio, 2));
      trailCanvas.height = Math.floor(height * Math.min(window.devicePixelRatio, 2));
      trailContext.fillStyle = '#050708';
      trailContext.fillRect(0, 0, trailCanvas.width, trailCanvas.height);
      trailTexture.needsUpdate = true;
    };
    resize();
    window.addEventListener('resize', resize);

    const color = new THREE.Color();
    const animate = async (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const features = featuresRef.current;
      const activeLayers = layersRef.current;
      smoothedRms += (features.rms - smoothedRms) * 0.14;

      const hue = features.pitchHz && features.pitchConfidence > 0.35
        ? ((Math.log2(features.pitchHz / 82.41) % 1) + 1) % 1
        : 0.08 + features.spectralCentroid * 0.52;
      const warmth = 0.52 + features.spectralCentroid * 0.3;
      color.setHSL(hue, 0.76 + features.high * 0.18, warmth);
      harmonicMaterial.color.lerp(color, 0.12);
      harmonicMaterial.emissive.setHSL(hue, 0.7, 0.05 + features.rms * 0.18);
      harmonicMaterial.roughness = 0.68 - features.spectralCentroid * 0.42;

      if (features.pitchConfidence > 0.42) {
        const nextMode = getPitchClassIndex(features.pitchHz);
        if (nextMode !== lastGeometryMode && features.noteStability > 0.45) {
          harmonicMesh.geometry = geometrySet[nextMode];
          lastGeometryMode = nextMode;
        }
      }

      harmonicMesh.visible = activeLayers.draw3d && features.gate;
      particlePoints.visible = activeLayers.draw3d;
      trailPlane.visible = activeLayers.draw2d;

      const scale = 0.82 + smoothedRms * 2.2 + features.low * 0.55;
      harmonicMesh.scale.setScalar(scale);
      harmonicMesh.rotation.x += dt * (0.32 + features.mid * 2.5 + (1 - features.noteStability) * 0.8);
      harmonicMesh.rotation.y += dt * (0.22 + features.high * 3.0);
      harmonicMesh.rotation.z += dt * (features.noteStability * 0.4);

      key.intensity = 10 + features.rms * 46 + features.onset * 38;
      fill.intensity = 4 + features.high * 28;
      camera.position.x += ((features.high - 0.5) * 0.65 + features.onset * 0.18 - camera.position.x) * 0.045;
      camera.position.y += (1.0 + features.mid * 0.7 - camera.position.y) * 0.035;
      camera.position.z += (7.5 - features.low * 2.5 - features.onset * 0.7 - camera.position.z) * 0.035;
      camera.lookAt(0, 0, 0);

      if (activeLayers.draw2d) {
        drawTrails(trailContext, trailCanvas, features, hue, dt, trailX, trailY);
        trailX = wrap01(trailX + Math.cos(now * 0.0019 + features.mid * 4) * (0.002 + features.mid * 0.006));
        trailY = wrap01(trailY + Math.sin(now * 0.0016 + features.high * 7) * (0.002 + features.high * 0.006));
        trailTexture.needsUpdate = true;
      } else {
        trailContext.fillStyle = 'rgba(5, 7, 8, 0.08)';
        trailContext.fillRect(0, 0, trailCanvas.width, trailCanvas.height);
        trailTexture.needsUpdate = true;
      }

      if (activeLayers.draw3d && features.onset > 0.2) {
        spawnParticles(particles, maxParticles, features, hue);
      }
      updateParticles(particles, particlePositions, particleColors, dt, features);
      particleGeometry.attributes.position.needsUpdate = true;
      particleGeometry.attributes.color.needsUpdate = true;

      renderer.render(scene, camera);
      animation = requestAnimationFrame(animate);
    };

    animation = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animation);
      window.removeEventListener('resize', resize);
      geometrySet.forEach((geometry) => geometry.dispose());
      harmonicMaterial.dispose();
      particleGeometry.dispose();
      particleMaterial.dispose();
      trailTexture.dispose();
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
}

function createRenderer(): THREE.WebGLRenderer {
  return new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
}

function createChromaticGeometries(): THREE.BufferGeometry[] {
  return [
    new THREE.IcosahedronGeometry(1.2, 4), // C
    new THREE.BoxGeometry(1.65, 1.65, 1.65, 3, 3, 3), // C#
    new THREE.TorusGeometry(0.9, 0.23, 24, 96), // D
    new THREE.ConeGeometry(1.05, 1.95, 6, 2), // D#
    new THREE.TorusKnotGeometry(0.82, 0.22, 180, 18), // E
    new THREE.OctahedronGeometry(1.35, 3), // F
    new THREE.CapsuleGeometry(0.62, 1.25, 12, 32), // F#
    new THREE.TetrahedronGeometry(1.5, 2), // G
    new THREE.DodecahedronGeometry(1.25, 2), // G#
    new THREE.CylinderGeometry(0.85, 0.85, 1.75, 7, 2), // A
    new THREE.SphereGeometry(1.15, 24, 12, 0, Math.PI * 2, 0.22, Math.PI - 0.44), // A#
    new THREE.TorusKnotGeometry(0.78, 0.18, 160, 14, 3, 5) // B
  ];
}

function getPitchClassIndex(pitchHz: number | null): number {
  if (!pitchHz || pitchHz <= 0) {
    return 0;
  }

  const midi = Math.round(69 + 12 * Math.log2(pitchHz / 440));
  return ((midi % 12) + 12) % 12;
}

function drawTrails(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  features: AudioFeatures,
  hue: number,
  dt: number,
  trailX: number,
  trailY: number
) {
  const fade = features.gate ? 0.035 - features.rms * 0.018 : 0.075;
  context.fillStyle = `rgba(5, 7, 8, ${Math.max(0.012, fade)})`;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const cx = trailX * canvas.width;
  const cy = trailY * canvas.height;
  const radius = 20 + features.low * 280 + features.rms * 160;
  const count = 4 + Math.floor(features.mid * 18 + features.onset * 24);
  const alpha = features.gate ? 0.16 + features.rms * 0.3 : 0.04;

  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.globalCompositeOperation = 'lighter';

  for (let i = 0; i < count; i += 1) {
    const phase = i / Math.max(1, count - 1);
    const angle = performance.now() * 0.0006 + phase * Math.PI * 2 + features.high * 2;
    const x = cx + Math.cos(angle) * radius * (0.2 + phase);
    const y = cy + Math.sin(angle * (1.0 + features.noteStability * 0.5)) * radius * (0.2 + features.spectralCentroid);
    context.strokeStyle = `hsla(${Math.round(hue * 360 + phase * 50)}, ${72 + features.high * 22}%, ${42 + features.rms * 34}%, ${alpha})`;
    context.lineWidth = 1 + features.rms * 14 + features.onset * 10;
    context.beginPath();
    context.moveTo(cx, cy);
    context.quadraticCurveTo((cx + x) / 2, y + Math.sin(dt + phase) * 50, x, y);
    context.stroke();
  }

  context.globalCompositeOperation = 'source-over';
}

function spawnParticles(particles: Particle[], maxParticles: number, features: AudioFeatures, hue: number) {
  const count = Math.floor(8 + features.onset * 34 + features.high * 18);
  for (let i = 0; i < count; i += 1) {
    if (particles.length >= maxParticles) {
      particles.shift();
    }

    const angle = Math.random() * Math.PI * 2;
    const speed = 0.6 + features.peak * 5 + Math.random() * features.high * 3;
    particles.push({
      position: new THREE.Vector3(0, 0, 0),
      velocity: new THREE.Vector3(Math.cos(angle) * speed, (Math.random() - 0.2) * speed, Math.sin(angle) * speed),
      life: 0.7 + Math.random() * 1.2,
      hue: wrap01(hue + (Math.random() - 0.5) * 0.18)
    });
  }
}

function updateParticles(
  particles: Particle[],
  positions: Float32Array,
  colors: Float32Array,
  dt: number,
  features: AudioFeatures
) {
  const color = new THREE.Color();
  particles.forEach((particle, index) => {
    particle.life -= dt * (0.55 + features.high);
    particle.velocity.multiplyScalar(0.985 - features.low * 0.04);
    particle.velocity.y += dt * (-0.2 + features.mid * 0.75);
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

function wrap01(value: number) {
  return ((value % 1) + 1) % 1;
}

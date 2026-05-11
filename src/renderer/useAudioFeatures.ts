import { useEffect, useRef, useState } from 'react';
import type { AudioFeatures } from '../shared/audio';
import { DEFAULT_FEATURES } from '../shared/audio';
import { getAudioClient } from './audioClient';

export function useAudioFeatures() {
  const latestRef = useRef<AudioFeatures>(DEFAULT_FEATURES);
  const [latest, setLatest] = useState<AudioFeatures>(DEFAULT_FEATURES);

  useEffect(() => {
    const audio = getAudioClient();
    let cancelled = false;
    let frame = 0;
    let lastReactUpdate = 0;

    const tick = async (now: number) => {
      try {
        latestRef.current = await audio.getLatestFeatures();
        if (now - lastReactUpdate > 66) {
          setLatest(latestRef.current);
          lastReactUpdate = now;
        }
      } catch {
        latestRef.current = DEFAULT_FEATURES;
      }

      if (!cancelled) {
        frame = requestAnimationFrame(tick);
      }
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  return { latest, latestRef };
}

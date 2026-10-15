// Renders the procedural ambience sounds off the main thread, one at a time,
// most important first, so the valley starts sounding alive within moments.
import { SOUNDS, rng, type SoundName } from './synth';

export interface SynthJob {
  key: string;
  name: SoundName;
  seed: number;
}

self.onmessage = (e: MessageEvent<{ sr: number; jobs: SynthJob[] }>) => {
  const { sr, jobs } = e.data;
  for (const job of jobs) {
    const s = SOUNDS[job.name](rng(job.seed), sr);
    (self as unknown as Worker).postMessage({ key: job.key, sr: s.sr, channels: s.channels }, s.channels.map((c) => c.buffer as ArrayBuffer));
  }
  (self as unknown as Worker).postMessage({ done: true });
};

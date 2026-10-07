"use client";
import { prepareAudioMix } from "./mix-audio";
import { integratedLoudness } from "./loudness";
import type { Project } from "./studio";

/*
 * Measures the cut's loudness in the browser, on the same mix the browser export encodes (prepareAudioMix: the clips' own
 * sound and the sound lanes, at their saved gain, pan and fades, held under full scale). Reads the project's own media from
 * this workspace, sends nothing anywhere and costs nothing.
 */
export type CutLoudness = { lufs: number | null; /** The mix was turned down to stay under full scale. */ reduced: boolean };

export async function measureCutLoudness(project: Project, signal: AbortSignal): Promise<CutLoudness> {
  const mix = await prepareAudioMix(project, signal);
  if (!mix.buffer) return { lufs: null, reduced: false };
  const lufs = integratedLoudness(mix.buffer.getChannelData(0), mix.buffer.getChannelData(1), mix.buffer.sampleRate);
  return { lufs, reduced: mix.gain < 1 };
}

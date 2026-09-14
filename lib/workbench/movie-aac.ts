"use client";

import {
  AudioBufferSource,
  Mp4OutputFormat,
  NullTarget,
  Output,
  Quality,
  type EncodedPacket,
} from "mediabunny";

let registered: Promise<void> | undefined;
export function prepareMovieAac() {
  return (registered ??= import("@mediabunny/aac-encoder")
    .then(({ registerAacEncoder }) => registerAacEncoder())
    .catch((error) => {
      registered = undefined;
      throw error;
    }));
}

/** The pinned FFmpeg AAC-LC encoder primes one 1024-sample frame. The extension
 * assigns consecutive timestamps, discarding FFmpeg's negative PTS. Retain the
 * priming packet at a negative timestamp so the MP4 edit list trims it, then
 * end the last packet at the timeline boundary. The impulse regression must
 * pass before upgrading @mediabunny/aac-encoder 1.56.2.
 */
export async function encodeMovieAac(buffer: AudioBuffer, signal: AbortSignal) {
  await prepareMovieAac();
  signal.throwIfAborted();
  const packets: { packet: EncodedPacket; meta?: EncodedAudioChunkMetadata }[] =
    [];
  const output = new Output({
    target: new NullTarget(),
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
  });
  const source = new AudioBufferSource(
    {
      codec: "aac",
      quality: new Quality({ bitrate: 192_000 }),
      onEncodedPacket: (packet, meta) => {
        signal.throwIfAborted();
        if (packet.timestamp < buffer.duration)
          packets.push({
            packet: packet.clone({
              duration: Math.min(
                packet.duration,
                buffer.duration - packet.timestamp,
              ),
            }),
            meta,
          });
      },
    },
    { startTimestamp: -1024 / buffer.sampleRate },
  );
  output.addAudioTrack(source);
  const abort = () => {
    void output.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await output.start();
    await source.add(buffer);
    source.close();
    await output.finalize();
    signal.throwIfAborted();
    return packets;
  } finally {
    signal.removeEventListener("abort", abort);
    if (output.state !== "finalized" && output.state !== "canceled")
      await output.cancel();
  }
}

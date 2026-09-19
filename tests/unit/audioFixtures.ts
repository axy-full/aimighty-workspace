/** A generated PCM WAV (mono, 16-bit) of the given length: the smallest real audio original a test can store. */
export function wav(seconds: number, rate = 48000): Buffer {
  const frames = Math.round(seconds * rate), b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 0.4 * 32767), 44 + i * 2);
  return b;
}

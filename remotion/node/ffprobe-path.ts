import { createRequire } from "node:module";
import path from "node:path";

/** The ffprobe that ships with Remotion's compositor package, so the worker needs no second ffmpeg. Kept apart from probe.ts because it uses import.meta (the command is an ES module; the unit tests are not). */
export function bundledFfprobe(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@remotion/compositor-linux-x64-gnu/package.json");
  return path.join(path.dirname(pkg), "ffprobe");
}

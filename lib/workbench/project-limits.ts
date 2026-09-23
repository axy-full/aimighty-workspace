/**
 * How much one project holds. Sized for a feature film: about 180 scenes,
 * 900 shots with two storyboard frames and three takes each, a Rig shot per
 * storyboard frame (each with its frame and a cast input or two as nodes),
 * and a cut of every shot, with room to spare.
 */
export const PROJECT_LIMITS = {
  assets: 6000,
  nodes: 4000,
  shots: 1500,
} as const;

/** A project's JSON once unpacked: a feature's full project is about 7 MB. */
export const PROJECT_JSON_BYTES = 24_000_000;
/** Bytes a save may send over the wire (Vercel functions take 4.5 MB). Larger saves are sent gzipped. */
export const PROJECT_WIRE_BYTES = 4_000_000;
/** Saves at or above this size are gzipped by the browser before sending. */
export const PROJECT_GZIP_FROM = 256_000;
/** The request header naming a gzipped project body. */
export const PROJECT_ENCODING_HEADER = "X-Particl-Body-Encoding";
/** A limit as the site prints it ("6,000"). */
export const limitText = (value: number) => value.toLocaleString("en-US");

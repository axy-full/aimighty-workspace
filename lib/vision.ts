import { engineMock } from "./mock";
import { recoveryFetch } from "./recovery";

/**
 * Google Cloud Vision text detection, DIRECT (the owner, 14 Oct 2026: "Google Cloud Vision text detection (GOOGLE_VISION_API_KEY is set)"): the text in a still, with where
 * each word sits. One request, answered at once; used by the label check (lib/visionLabel.ts), which diffs what is read against what must be there.
 *
 * Settings (names only): GOOGLE_VISION_API_KEY (set) and VISION_LABEL_CHECK_ENABLED (the kill switch, lib/engineGate.ts). No base-address setting: the address is fixed.
 * Under ENGINE_MOCK=1 nothing is called: a fixture answers in process.
 *
 * What is called: `POST https://vision.googleapis.com/v1/images:annotate` with the header `x-goog-api-key` (never the address), one image as base64 bytes read on the
 * server (no link of ours leaves Particl) and the feature `TEXT_DETECTION`. The reply's first `textAnnotations` entry is all the text; the rest are its words with their boxes.
 * Only that one https host is called, and **no redirect is followed** (`redirect: "error"`). **The request and reply field names, the endpoint, and API-key auth
 * on this endpoint are Google's public API as the plan records it (docs/plans/provider-adapters.md § 4) and are TO CONFIRM in the first qualification run.**
 * Every reply is read defensively; nothing is billed on a failure we can see (Google bills images processed).
 */
export const VISION_SWITCH = "VISION_LABEL_CHECK_ENABLED";
export const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const TIMEOUT_MS = 30_000;
/** One request is 10 MB at most (an image is 20 MB; a request is 10). */
export const VISION_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;
export const VISION_MAX_WORDS = 200;

const visionKey = (): string | null => process.env.GOOGLE_VISION_API_KEY || null;
export const visionConfigured = (): boolean => Boolean(visionKey()) || engineMock();

/** A refusal or failure from Google (or from reaching it). `rejectedBeforeWork`: it answered a clear refusal (4xx other than 408) before analysing the image. */
export class VisionError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly rejectedBeforeWork = false) { super(message); this.name = "VisionError"; }
}

export type VisionWord = { text: string; box: [number, number, number, number] };
export type VisionText = { text: string; words: VisionWord[] };

type Deps = { fetch?: typeof fetch };

/* ── Fixture (ENGINE_MOCK=1) ────────────────────────────────────────────────── */
/** The fixture reads a picture that begins `MOCKTEXT:` as showing the text after it; any other picture shows no text. `[[mock-refuse]]` after it is a refusal. */
const MOCK_PREFIX = "MOCKTEXT:";

function mockRead(bytes: Buffer): VisionText {
  const head = bytes.toString("utf8", 0, Math.min(bytes.length, 4000));
  if (!head.startsWith(MOCK_PREFIX)) return { text: "", words: [] };
  const text = head.slice(MOCK_PREFIX.length);
  if (text.startsWith("[[mock-refuse]]")) throw new VisionError("Google refused the request: mock refusal.", 400, true);
  const words = text.split(/\s+/).filter(Boolean).slice(0, VISION_MAX_WORDS).map((w, i): VisionWord => ({ text: w, box: [i * 10, 0, i * 10 + 9, 8] }));
  return { text, words };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The text in one still, read once. The caller holds the reservation; this is the one paid request, and it is never repeated for the same check. */
export async function detectText(input: { bytes: Buffer }, deps: Deps = {}): Promise<VisionText> {
  if (!input.bytes.length || input.bytes.length > VISION_IMAGE_LIMIT_BYTES) throw new VisionError("The picture is empty or larger than 10 MB.", null, true);
  if (engineMock()) return mockRead(input.bytes);
  const key = visionKey();
  if (!key) throw new VisionError("This is not set up: GOOGLE_VISION_API_KEY is needed.", null, true);
  let res: Response;
  try {
    res = await (deps.fetch ?? recoveryFetch)(VISION_ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": key, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ image: { content: input.bytes.toString("base64") }, features: [{ type: "TEXT_DETECTION" }] }] }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new VisionError("Google did not answer.");
  }
  const raw = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) {
    const err = json.error && typeof json.error === "object" ? (json.error as { message?: unknown }) : {};
    const detail = typeof err.message === "string" ? err.message : "";
    throw new VisionError(detail ? `Google refused the request: ${detail.slice(0, 200)}` : `Google answered ${res.status}.`, res.status, res.status >= 400 && res.status < 500 && res.status !== 408);
  }
  const first = Array.isArray(json.responses) && json.responses[0] && typeof json.responses[0] === "object" ? (json.responses[0] as Record<string, unknown>) : null;
  if (!first) throw new VisionError("Google's reply held no answer for the picture.");
  /* An error inside a 200 is that image's own: nothing was read. */
  if (first.error && typeof first.error === "object") {
    const message = (first.error as { message?: unknown }).message;
    throw new VisionError(typeof message === "string" && message ? `Google could not read the picture: ${message.slice(0, 200)}` : "Google could not read the picture.", null, true);
  }
  const annotations = Array.isArray(first.textAnnotations) ? first.textAnnotations : [];
  /* No text in the picture: Google leaves textAnnotations out. That is an answer (nothing there), not a failure. */
  if (!annotations.length) return { text: "", words: [] };
  const all = annotations[0] && typeof annotations[0] === "object" ? (annotations[0] as { description?: unknown }).description : undefined;
  const full = first.fullTextAnnotation && typeof first.fullTextAnnotation === "object" ? (first.fullTextAnnotation as { text?: unknown }).text : undefined;
  const text = typeof all === "string" ? all : typeof full === "string" ? full : null;
  if (text == null) throw new VisionError("Google's reply held no text field.");
  const words: VisionWord[] = [];
  for (const a of annotations.slice(1, 1 + VISION_MAX_WORDS)) {
    const word = a && typeof a === "object" ? (a as { description?: unknown; boundingPoly?: { vertices?: unknown } }) : null;
    if (!word || typeof word.description !== "string") continue;
    const v = Array.isArray(word.boundingPoly?.vertices) ? (word.boundingPoly!.vertices as { x?: unknown; y?: unknown }[]) : [];
    const xs = v.map((p) => num(p?.x)), ys = v.map((p) => num(p?.y));
    words.push({ text: word.description, box: v.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 0, 0] });
  }
  return { text, words };
}

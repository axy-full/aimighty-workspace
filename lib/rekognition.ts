import { signRequest, sha256Hex } from "./storage/r2";
import { engineMock } from "./mock";
import { recoveryFetch } from "./recovery";

/**
 * AWS Rekognition `CompareFaces`, signed with the SigV4 header signing the storage code already has (lib/storage/r2.ts `signRequest`),
 * with no AWS SDK, so nothing the SDK reads by itself (an AWS_* setting, a shared config file, an instance role) can ever be consulted.
 *
 * Mumbai (`ap-south-1`, so the faces do not leave India for this step). Stateless: no face collection, no IndexFaces, no search; the two
 * images go in the request and only a similarity score comes back. Nothing here stores or logs an image, a crop or a face vector.
 *
 * Settings (names only; set in the deployment): REKOGNITION_ACCESS_KEY_ID, REKOGNITION_SECRET_ACCESS_KEY, REKOGNITION_REGION
 * (default ap-south-1) and REKOGNITION_ENABLED (the kill switch, lib/engineGate.ts). The IAM user is limited to CompareFaces and DetectFaces.
 * Under ENGINE_MOCK=1 nothing is called: a fixture answers (below).
 */
export const REKOGNITION_SWITCH = "REKOGNITION_ENABLED";
const DEFAULT_REGION = "ap-south-1";
/** Vendor price, Mumbai, first million images a month: $0.00125 an image (AWS price list of 11 Sep 2026, as recorded in docs/plans/provider-adapters.md § 3). TO CONFIRM on the first bill. */
export const REKOGNITION_USD_PER_IMAGE = 0.00125;
/** One call is priced as one image (docs/plans/provider-adapters.md § 3: "one image per call; to be confirmed on the first bill"). */
export const REKOGNITION_IMAGES_PER_CALL = 1;
export const REKOGNITION_MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** What a comparison says: the best similarity (0 to 100) among the faces found in the target, and how many faces it found. */
export type FaceComparison = { similarity: number; facesFound: number };

/**
 * Why a call did not give a score. `none`: AWS answered before analysis (no face in an image, an image too small or in a format it cannot read),
 * which it does not bill. `provider`: anything else (a refusal, throttling, a 5xx, a network failure, a timeout, a missing key): no score, and
 * nothing is assumed about the bill, so the caller records nothing as charged.
 */
export class RekognitionError extends Error {
  constructor(message: string, readonly kind: "no-face" | "bad-image" | "provider", readonly status: number | null = null) { super(message); this.name = "RekognitionError"; }
}

export type RekognitionDeps = { fetch?: typeof fetch; now?: () => Date; env?: Record<string, string | undefined> };

/** The mock's fixture: images that begin "mock-face:<who>" are the same face when <who> is the same; "mock-noface" has no face; "mock-error" is a provider failure. */
function mockCompare(source: Buffer, target: Buffer): FaceComparison {
  const tag = (b: Buffer) => b.subarray(0, 64).toString("utf8");
  for (const side of [source, target]) {
    if (tag(side).startsWith("mock-error")) throw new RekognitionError("The face check could not be done. Nothing was billed.", "provider", 503);
    if (tag(side).startsWith("mock-noface")) throw new RekognitionError("No face was found in the image.", "no-face", 400);
  }
  const who = (b: Buffer) => /^mock-face:([\w-]+)/.exec(tag(b))?.[1] ?? null;
  const a = who(source), b = who(target);
  if (!a || !b) throw new RekognitionError("The image could not be read as a face.", "bad-image", 400);
  return { similarity: a === b ? 99.2 : 11.4, facesFound: 1 };
}

/** One CompareFaces call: the largest face in `source` against the faces in `target`. Throws RekognitionError; never returns a guess. */
export async function compareFaces(source: Buffer, target: Buffer, deps: RekognitionDeps = {}): Promise<FaceComparison> {
  for (const image of [source, target]) {
    if (!image.length || image.length > REKOGNITION_MAX_BYTES) throw new RekognitionError("The image is empty or over 5 MB.", "bad-image");
  }
  if (engineMock()) return mockCompare(source, target);
  const env = deps.env ?? process.env;
  const accessKeyId = env.REKOGNITION_ACCESS_KEY_ID, secretAccessKey = env.REKOGNITION_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new RekognitionError("The face check is not set up: REKOGNITION_ACCESS_KEY_ID and REKOGNITION_SECRET_ACCESS_KEY are needed.", "provider");
  const region = (env.REKOGNITION_REGION ?? DEFAULT_REGION).trim() || DEFAULT_REGION;
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new RekognitionError("REKOGNITION_REGION is not a region name.", "provider");
  const url = new URL(`https://rekognition.${region}.amazonaws.com/`);
  /* SimilarityThreshold 0: every face found comes back with its score, so the caller (not AWS's default of 80) decides what counts as the same face. */
  const body = JSON.stringify({ SourceImage: { Bytes: source.toString("base64") }, TargetImage: { Bytes: target.toString("base64") }, SimilarityThreshold: 0 });
  const signed = signRequest({
    method: "POST", url, payloadHash: sha256Hex(body), credentials: { accessKeyId, secretAccessKey }, region, service: "rekognition", date: (deps.now ?? (() => new Date()))(),
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "RekognitionService.CompareFaces" },
  });
  let res: Response;
  try {
    res = await (deps.fetch ?? recoveryFetch)(signed.url, { method: "POST", headers: signed.headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new RekognitionError("The face check could not be reached. Nothing was billed.", "provider");
  }
  const text = await res.text().catch(() => "");
  let json: { __type?: string; Message?: string; message?: string; FaceMatches?: { Similarity?: number }[]; UnmatchedFaces?: unknown[] } = {};
  try { json = JSON.parse(text); } catch { /* not JSON: handled below */ }
  if (!res.ok) {
    const type = String(json.__type ?? "").split("#").pop() ?? "";
    const said = String(json.Message ?? json.message ?? "");
    /* Answered before analysis, so not billed: a bad parameter (no face in an image, too small, not a JPEG or PNG) or an image that cannot be read. */
    if (res.status === 400 && (type === "InvalidParameterException" || type === "InvalidImageFormatException" || type === "ImageTooLargeException")) {
      throw new RekognitionError(said || "The image could not be used.", /no faces? in/i.test(said) ? "no-face" : "bad-image", 400);
    }
    throw new RekognitionError("The face check could not be done. Nothing was billed.", "provider", res.status);
  }
  const matches = Array.isArray(json.FaceMatches) ? json.FaceMatches : [];
  const scores = matches.map((m) => Number(m.Similarity)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  const found = matches.length + (Array.isArray(json.UnmatchedFaces) ? json.UnmatchedFaces.length : 0);
  /* A 200 with no face in the target at all is "no face", not a score of 0. */
  if (!found) throw new RekognitionError("No face was found in the image.", "no-face", 200);
  return { similarity: scores.length ? Math.max(...scores) : 0, facesFound: found };
}

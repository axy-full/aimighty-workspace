/**
 * The v30 Library's words for an element (docs/plans/v30-data-model.md § 6). Pure: no database, safe anywhere.
 *
 * An element keeps today's `kind` (character | location | prop | look | voice) for Rig, which reads any kind it does not
 * know as a character (lib/rig.ts › elementKind). The v30 kind sits beside it in `library_kind`, so filing a location as
 * an environment can never make Rig bind it as a face. The rows are filled by lib/elementLibrary.server.ts.
 */

export const LIBRARY_KINDS = ["character", "environment", "prop", "wardrobe", "brand", "product", "reference", "audio"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export const LIBRARY_ORIGINS = ["generated", "uploaded"] as const;
export type LibraryOrigin = (typeof LIBRARY_ORIGINS)[number];

export const LIBRARY_STATUSES = ["active", "draft"] as const;
export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];

export function isLibraryKind(v: unknown): v is LibraryKind {
  return typeof v === "string" && (LIBRARY_KINDS as readonly string[]).includes(v);
}

/**
 * Where today's "look" elements go in the Library. Owner question Q8 (plan § 9): a look is a style, not clothing, so
 * the plan proposes `reference`; the other answer is `wardrobe`. Changing this one value changes the backfill's answer
 * for every look not yet filed. Rows already filled keep what they were given.
 */
export const LOOK_LIBRARY_KIND: LibraryKind = "reference";

/** The v30 kind for one of today's kinds. A kind nobody knows reads as a character, exactly as Rig reads it. */
export function libraryKindOf(kind: string): LibraryKind {
  switch (kind) {
    case "location": return "environment";
    case "prop": return "prop";
    case "voice": return "audio";
    case "look":
    case "style": return LOOK_LIBRARY_KIND;   // `style` is the cast table's word for a look
    default: return "character";
  }
}

/** The nearest of today's kinds for a v30 kind: what `kind` holds for an element made under v30 (plan § 6.2). */
export function compatKindOf(kind: LibraryKind): "character" | "location" | "prop" | "look" | "voice" {
  switch (kind) {
    case "environment": return "location";
    case "wardrobe": case "brand": case "product": case "prop": return "prop";
    case "reference": return "look";
    case "audio": return "voice";
    default: return "character";
  }
}

/* ── @handles ───────────────────────────────────────────────────────────
   The handle grammar is the cast's token grammar (lib/cast.ts › expandCast, `@[A-Za-z][A-Za-z0-9_]{0,31}`), lowercased,
   so a handle is always read whole as one token: hence `maya_2` and never `maya-2`, which reads as @maya then "-2". */

export const HANDLE_MAX = 32;
export const HANDLE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * The engines' own citations are never a handle: `image<N>` and `video<N>` (which expandCast leaves alone) and
 * `audio<N>` (plan § 6.3). The bare words are reserved too: the cast's nameProblem() already refuses bare `image` and
 * `video` as names, and bare `audio` is held back with them (stricter than the plan).
 */
export function isReservedHandle(handle: string): boolean {
  return /^(image|video|audio)\d*$/i.test(handle);
}

export function isHandle(v: unknown): v is string {
  return typeof v === "string" && HANDLE_PATTERN.test(v) && !isReservedHandle(v);
}

/** Cut to at most `max` characters without leaving an underscore at the end. */
function cut(s: string, max: number): string {
  return s.slice(0, max).replace(/_+$/, "");
}

/**
 * A handle's base from an element's name: accents dropped, lowercased, every run of other characters one `_`, trimmed
 * to 32. A name that does not start with a letter gets its kind in front (`prop_1920s_radio`); a name with nothing
 * usable in it ("माया", "!!!") is its kind alone.
 */
export function handleBase(name: string, kind: LibraryKind): string {
  const plain = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const base = plain.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!base) return kind;
  return cut(/^[a-z]/.test(base) ? base : `${kind}_${base}`, HANDLE_MAX);
}

/** `base` with its `_<n>` suffix, the base cut so the whole stays within 32 characters. */
export function withSuffix(base: string, n: number): string {
  const suffix = `_${n}`;
  return cut(base, HANDLE_MAX - suffix.length) + suffix;
}

export type HandleCandidate = { id: string; name: string; libraryKind: LibraryKind };

/**
 * Handles for elements that have none, in the order given (the caller's order: workspace-wide first, then oldest).
 * The first holder of a base keeps it; later ones get `_2`, `_3`, … `taken` holds every handle already in the
 * workspace; it is case-blind and is not changed.
 */
export function assignHandles(candidates: readonly HandleCandidate[], taken: Iterable<string>): Map<string, string> {
  const used = new Set([...taken].map((h) => h.toLowerCase()));
  const out = new Map<string, string>();
  for (const c of candidates) {
    const base = handleBase(c.name, c.libraryKind);
    let handle = base;
    for (let n = 2; used.has(handle) || isReservedHandle(handle); n++) handle = withSuffix(base, n);
    used.add(handle);
    out.set(c.id, handle);
  }
  return out;
}

/* ── Origin ─────────────────────────────────────────────────────────────
   Written once and never rewritten. Promoted from a take → generated; else what its first version stands on: a photo
   someone brought → uploaded, a frame the product made or a trained likeness → generated; nothing at all → uploaded.

   The edge case, on purpose: an element filled while it has no version (made by hand, or mirrored from a cast member
   with no still) is `uploaded`, and stays `uploaded` if its first version is later a generated frame. Origin says
   how the element came into the Library, decided once; it is not recomputed from versions added afterwards. */

export type FirstVersion = { uploadId: string | null; genId: string | null; identityId: string | null } | null;

export function originOf(fromGenId: string | null, first: FirstVersion): LibraryOrigin {
  if (fromGenId) return "generated";
  if (first?.uploadId) return "uploaded";
  if (first?.genId || first?.identityId) return "generated";
  return "uploaded";
}

/* ── A crop is its own upload (§ 6.4) ───────────────────────────────────
   The three upload columns a crop row carries. Exactly one source; a whole-pixel rectangle; the source's SHA-256, so a
   crop always says which bytes it was cut from. Storing the cut bytes is a later change. */

export type CropInput = {
  fromUpload?: string | null;
  fromGen?: string | null;
  x: number; y: number; w: number; h: number;
  sourceSha256: string;
};

export type CropColumns = { derived_from_upload: string | null; derived_from_gen: string | null; derivation: string };

export function cropDerivation(input: CropInput): CropColumns {
  const upload = input.fromUpload?.trim() || null;
  const gen = input.fromGen?.trim() || null;
  if ((upload ? 1 : 0) + (gen ? 1 : 0) !== 1) throw new Error("A crop is cut from exactly one upload or take.");
  const whole = (v: number) => Number.isSafeInteger(v) && v >= 0;
  if (![input.x, input.y, input.w, input.h].every(whole) || input.w < 1 || input.h < 1) {
    throw new Error("A crop is a rectangle of whole pixels.");
  }
  if (!/^[0-9a-f]{64}$/.test(input.sourceSha256)) throw new Error("A crop names its source's SHA-256.");
  return {
    derived_from_upload: upload,
    derived_from_gen: gen,
    derivation: JSON.stringify({ op: "crop", x: input.x, y: input.y, w: input.w, h: input.h, source_sha256: input.sourceSha256 }),
  };
}

/**
 * Rig — the node layer (brief 3).
 *
 * An ELEMENT is a named thing a production keeps coming back to: a character,
 * a location, a prop, a look, a voice. An ATTRIBUTE is one part of it that can
 * change on its own — a face, a wardrobe, a plate, a turntable. A VERSION is
 * one state of an attribute, and versions are additive: making v2 never alters
 * a take made with v1. It is the SWAP that costs.
 *
 * A shot binds a SLOT to a port. The port is the triple
 *
 *     elementId : attributeId : versionId
 *
 * and it is the one idea the whole layer rests on. It is what a wire carries on
 * the canvas, what the compiler resolves into an actual image, and what a take's
 * provenance records. Because one function produces all three, they cannot drift.
 *
 * Two nulls in that triple carry meaning, and they are the reason a binding is
 * one row rather than several:
 *
 *   attributeId null   the bundle — every current version this element holds
 *   versionId   null   follow current — this shot moves when the element moves
 *
 * A non-null version is a pin: the shot is held on that version and will not
 * follow. On the canvas the two are drawn as the inherited wire and the
 * override wire, which is the whole visual difference between them.
 *
 * Everything here is pure. The reads and writes live in lib/elements.ts, the
 * money in the quote engine, and nothing in this file touches the database.
 */

/* ── Slots ──────────────────────────────────────────────────────────────
   What a shot points at. Five, from the design, and they are deliberately
   not the same list as element kinds: BACKGROUND is filled by a location,
   ELEMENT by a prop, and KEYFRAME by a still that may be a take rather
   than an element at all. */

export const SLOTS = ["character", "background", "element", "look", "keyframe"] as const;
export type Slot = (typeof SLOTS)[number];

export const SLOT_LABELS: Record<Slot, string> = {
  character: "CHARACTER", background: "BACKGROUND", element: "ELEMENT",
  look: "LOOK", keyframe: "KEYFRAME",
};

export function isSlot(v: unknown): v is Slot {
  return typeof v === "string" && (SLOTS as readonly string[]).includes(v);
}

/* ── Element kinds ──────────────────────────────────────────────────────
   The cast's four kinds, plus voice. The cast table calls a look 'style',
   which is the same thing under an older name; castKind() and elementKind()
   translate between them so neither side has to know about the other. */

export const ELEMENT_KINDS = ["character", "location", "prop", "look", "voice"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export function isElementKind(v: unknown): v is ElementKind {
  return typeof v === "string" && (ELEMENT_KINDS as readonly string[]).includes(v);
}

/** The cast's word for an element kind — 'style' is what the cast table stores. */
export function castKind(kind: ElementKind): string {
  return kind === "look" ? "style" : kind === "voice" ? "character" : kind;
}

/** An element kind from the cast's word, for the element mirrored off a cast member. */
export function elementKind(cast: string): ElementKind {
  return cast === "style" ? "look" : isElementKind(cast) ? cast : "character";
}

/** Which slot an element of this kind lands in when it is bound. */
export function slotFor(kind: ElementKind): Slot {
  switch (kind) {
    case "location": return "background";
    case "prop": return "element";
    case "look": return "look";
    default: return "character";
  }
}

/* ── Attributes ─────────────────────────────────────────────────────────
   The parts of an element that version independently. A character is four
   of them, which is the point of the whole design: a shot can hold last
   week's wardrobe without leaving the character. */

export const ATTRIBUTE_KINDS = [
  "face", "hair", "wardrobe", "voice",   // character
  "plate",                                // location
  "turntable", "detail",                  // prop
  "look",                                 // look
] as const;
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

export function isAttributeKind(v: unknown): v is AttributeKind {
  return typeof v === "string" && (ATTRIBUTE_KINDS as readonly string[]).includes(v);
}

/** The attributes an element of this kind is made of, in the order they read. */
export function attributesOf(kind: ElementKind): AttributeKind[] {
  switch (kind) {
    case "character": return ["face", "hair", "wardrobe", "voice"];
    case "location": return ["plate"];
    case "prop": return ["turntable", "detail"];
    case "look": return ["look"];
    case "voice": return ["voice"];
  }
}

/**
 * The attribute a still stands for when an element is first made from one asset.
 *
 * A cast member has exactly one still today, so mirroring it into Rig has to
 * decide what that still IS. A face for a person, a plate for a place: the
 * first attribute of the kind, which is also the one a prompt reaches for
 * when nothing more specific is bound.
 */
export function primaryAttribute(kind: ElementKind): AttributeKind {
  return attributesOf(kind)[0];
}

/** Whether this attribute is something the engines are given as a picture. */
export function isVisual(kind: AttributeKind): boolean {
  return kind !== "voice";
}

/* ── Ports ──────────────────────────────────────────────────────────────
   The triple, and the two directions between it and its string form. The
   string is for display, logs and the wire; the three columns are what the
   database indexes, so a dependent lookup is an index scan either way. */

export type Port = {
  elementId: string;
  /** null means the bundle: every current version this element holds. */
  attributeId: string | null;
  /** null means follow current; a value is a pin the element cannot move. */
  versionId: string | null;
};

/** `elementId:attributeId:versionId`, with an empty segment for each null. */
export function portKey(p: Port): string {
  return `${p.elementId}:${p.attributeId ?? ""}:${p.versionId ?? ""}`;
}

const SEGMENT = /^[A-Za-z0-9_-]*$/;

/**
 * The triple back from its string form.
 *
 * Strict on purpose: a port that cannot be read is not a port that resolves to
 * something reasonable, because the something reasonable would be billed for.
 */
export function parsePort(s: unknown): Port | null {
  if (typeof s !== "string") return null;
  const parts = s.split(":");
  if (parts.length !== 3) return null;
  const [elementId, attributeId, versionId] = parts;
  if (!elementId || !parts.every((p) => SEGMENT.test(p))) return null;
  // A version without an attribute names nothing: the bundle has no one version.
  if (versionId && !attributeId) return null;
  return { elementId, attributeId: attributeId || null, versionId: versionId || null };
}

/** Whether this binding is held on a version rather than following the element. */
export const isPinned = (p: Port): boolean => p.versionId !== null;

/**
 * Whether a change to one version reaches a port.
 *
 * This is the predicate the impact panel counts with, so it decides what a
 * producer is told a change costs. A port following current moves with the
 * element; a port pinned to the version being changed moves too, because it
 * is that version; a port pinned to any other version does not move at all.
 *
 * The element has to be named. A bundle port carries no attribute, so without
 * it the predicate would answer "yes" for a change to any attribute of any
 * element in the workspace: change one plate on a location and every character
 * wired as a bundle would be counted and quoted for.
 */
export function portFollows(p: Port, elementId: string, attributeId: string, versionId: string): boolean {
  if (p.elementId !== elementId) return false;
  if (p.attributeId !== null && p.attributeId !== attributeId) return false;
  return p.versionId === null || p.versionId === versionId;
}

/* ── Reading a port out of a take that was made before Rig ──────────────
   Every take already records which names it cited and which files it
   attached. What it does not record is which file belonged to which name,
   and without that a backfilled version history would be a guess.

   It is recoverable, because the compiler wrote the mapping down itself.
   Expanding @Cass rewrites it as @Image3 and appends a line at the end of
   the prompt reading "@Image3 is Cass: ...". That line names the citation
   and the image index together, and the index is the position of the file
   in the take's own reference list. So the take says, in its own words,
   which photograph stood behind which name.

   Where the line is absent — a cast member with no description, or a take
   from a path that never expanded a citation — nothing is inferred. A
   version history invented from the element's state today would claim a
   take used a wardrobe that did not exist when it was rendered. */

export type TakeRef = { uploadId?: string | null; genId?: string | null; role?: string; kind?: string };

const CITATION = /@Image(\d+)\s+is\s+([A-Za-z][A-Za-z0-9_]{0,31})\s*:/g;

/**
 * Which upload stood behind each cited name in one take.
 *
 * `refs` is the take's reference list in the order it was sent, which is the
 * order the image indices were assigned. First mention wins, because that is
 * the one the compiler assigned the index to.
 *
 * The whole mapping is rejected unless it is positionally sound, and that
 * check is the reason this can be trusted at all. The compiler attaches cast
 * stills AFTER whatever the person brought themselves, in citation order, so
 * the indices it hands out are always an ascending run of consecutive numbers
 * ending at the last image. Anything else means the text is not the text the
 * compiler wrote: on the video path the stored prompt is the prompt writer's
 * rewrite, and a model that renumbers a citation while rearranging a sentence
 * would otherwise hand this function a name attached to the wrong photograph.
 * A version history that is merely missing is recoverable. One that is wrong
 * is worse than none.
 */
export function citedStills(compiled: string, refs: TakeRef[]): { name: string; uploadId: string }[] {
  const images = refs
    .filter((r) => (r.kind ?? "image") === "image" && (r.role ?? "reference_image") === "reference_image")
    .map((r) => r.uploadId ?? null);

  const seen = new Set<string>();
  const hits: { name: string; index: number }[] = [];
  for (const m of String(compiled ?? "").matchAll(CITATION)) {
    const name = m[2];
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ name, index: Number(m[1]) });
  }
  if (!hits.length) return [];

  const last = hits[hits.length - 1].index;
  const consecutive = hits.every((h, i) => h.index === hits[0].index + i);
  const inRange = hits[0].index >= 1 && last <= images.length;
  if (!consecutive || !inRange || last !== images.length) return [];

  const out: { name: string; uploadId: string }[] = [];
  for (const h of hits) {
    const uploadId = images[h.index - 1];
    if (!uploadId) return [];
    out.push({ name: h.name, uploadId });
  }
  return out;
}

/**
 * The versions one element has actually been rendered with, oldest first.
 *
 * A workspace that never replaced a still has one, which is the common case
 * and the reason this is worth doing at all: the history that exists is
 * short and true, rather than long and invented.
 */
export function versionsFromTakes(
  name: string,
  takes: { compiled: string; refs: TakeRef[]; createdAt: number }[],
  current: string | null,
): string[] {
  const key = name.toLowerCase();
  const byUpload = new Map<string, number>();
  for (const t of takes) {
    for (const c of citedStills(t.compiled, t.refs)) {
      if (c.name.toLowerCase() !== key) continue;
      const at = byUpload.get(c.uploadId);
      if (at === undefined || t.createdAt < at) byUpload.set(c.uploadId, t.createdAt);
    }
  }
  // The still standing behind the name today is the current version, whether
  // or not anything has been rendered with it yet.
  if (current && !byUpload.has(current)) byUpload.set(current, Number.MAX_SAFE_INTEGER);
  return [...byUpload.entries()].sort((a, b) => a[1] - b[1]).map(([uploadId]) => uploadId);
}

/* ── Version labels ─────────────────────────────────────────────────────
   Versions read as v1, v2, v3 in the order they were made. A label the team
   writes ("waxed coat") sits beside the number rather than replacing it, so
   two people talking about v2 always mean the same thing. */

export const versionNumber = (index: number): string => `v${index + 1}`;

export function versionLine(index: number, label: string | null | undefined): string {
  const n = versionNumber(index);
  /* A missing label is a version with no name, not a crash. The column is NOT
     NULL with a default, so this should not arrive — but this function is on
     the path that renders every price-bearing surface in Rig, and a thrown
     TypeError there takes the screen down rather than showing "v2". */
  const text = (label ?? "").trim();
  return text ? `${n} ${text}` : n;
}

/* ── A bundle, expanded ──────────────────────────────────────────────────
   Pure, and here rather than in the reader that uses it, because this is the
   rule that decides what a take was actually made from. Provenance records
   its output; the version counts on 2b read it back. Getting it wrong is not
   a display bug.

   A binding with no attribute means "every attribute of this element at its
   current version". Recorded as itself it said nothing at all — one row with
   a null version — so a take made through a bundle carried no version for
   anything, "make another from exactly this" had nothing to be exact about,
   and every version's take count read zero.

   An override on the same wire address supersedes the bundle for that
   attribute alone. On any OTHER address it does not: two characters on one
   shot each keep their own pins. */

export type BindingLike = {
  elementId: string; attributeId: string | null; versionId: string | null;
  slot: string; ordinal: number;
};

export type ExpandedPort = {
  elementId: string; attributeId: string | null; versionId: string | null;
  slot: string; ordinal: number;
};

export function expandPorts(
  bindings: BindingLike[],
  attributesOfElement: (elementId: string) => { id: string; currentId: string | null }[],
): ExpandedPort[] {
  const overridden = new Map<string, Set<string>>();
  for (const b of bindings) {
    if (!b.attributeId) continue;
    const key = `${b.slot}:${b.ordinal}:${b.elementId}`;
    const set = overridden.get(key) ?? new Set<string>();
    set.add(b.attributeId);
    overridden.set(key, set);
  }

  const out: ExpandedPort[] = [];
  for (const b of bindings) {
    if (b.attributeId) {
      const current = attributesOfElement(b.elementId).find((a) => a.id === b.attributeId);
      out.push({
        elementId: b.elementId, attributeId: b.attributeId,
        versionId: b.versionId ?? current?.currentId ?? null,
        slot: b.slot, ordinal: b.ordinal,
      });
      continue;
    }
    const skip = overridden.get(`${b.slot}:${b.ordinal}:${b.elementId}`) ?? new Set<string>();
    const attrs = attributesOfElement(b.elementId).filter((a) => !skip.has(a.id) && a.currentId);
    if (!attrs.length) {
      /* An element with nothing made for it yet is still cited by the shot,
         and saying so is truer than dropping it: the take really was rendered
         against an element that had no versions. */
      out.push({ elementId: b.elementId, attributeId: null, versionId: null, slot: b.slot, ordinal: b.ordinal });
      continue;
    }
    for (const a of attrs) {
      out.push({
        elementId: b.elementId, attributeId: a.id, versionId: a.currentId,
        slot: b.slot, ordinal: b.ordinal,
      });
    }
  }
  return out;
}

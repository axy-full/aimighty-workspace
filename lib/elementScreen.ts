import { isVisual, versionLine, type AttributeKind, type ElementKind } from "./rig";

/**
 * One element, and everything it reaches (brief 3, surface 2b).
 *
 * The counterpart to 2c. That surface answers "what does THIS SHOT use";
 * this one answers "what uses THIS ELEMENT", which is the question a swap has
 * to be able to answer before it is allowed to happen. So the numbers on this
 * screen are the same numbers the impact panel prices — a row saying eight
 * shots and a panel then charging for nine would make both untrustworthy, and
 * the panel is the one that spends.
 *
 * Everything here is pure. What it counts is passed in.
 */

/* ── What the server counted ────────────────────────────────────────────── */

export type VersionUse = {
  versionId: string;
  /** Shots PINNED to this version — they will not move when current does. */
  pinned: number;
  /** Finished takes recorded as having been made with it. */
  takes: number;
};

export type AttributeUse = {
  attributeId: string;
  /** Shots on this attribute that follow current rather than pinning. */
  following: number;
  versions: VersionUse[];
};

export type ElementUse = {
  /** Distinct shots that cite this element at all, by any of its ports. */
  shots: number;
  /** Photos behind the identity a version was trained from, when there is one. */
  photos: Record<string, number>;
  /** `SH03 v2` for a version promoted out of a take. */
  from: Record<string, string>;
  attributes: AttributeUse[];
};

export const EMPTY_USE: ElementUse = { shots: 0, photos: {}, from: {}, attributes: [] };

/* ── The rows ───────────────────────────────────────────────────────────── */

export type VersionIn = {
  id: string; label: string; status?: string | null;
  uploadId?: string | null; genId?: string | null; identityId?: string | null;
};

export type AttributeIn = {
  id: string; kind: string; label: string;
  currentId: string | null; locked: boolean; versions: VersionIn[];
};

export type ElementIn = {
  id: string; kind: string; name: string; description?: string;
  locked: boolean; lockedBy?: string | null; fromShotId?: string | null;
  attributes: AttributeIn[];
};

export type VersionRow = {
  id: string;
  /** `v2 overalls`, from the shared helper so it reads as it reads elsewhere. */
  line: string;
  current: boolean;
  ready: boolean;
  /** `in use` · `6 shots` · `2 takes` — what is actually holding it. */
  meta: string;
};

export type AttributeRow = {
  id: string;
  /** `WARDROBE` */
  name: string;
  kind: string;
  locked: boolean;
  /** `v2 overalls`, or nothing at all when no version has been made yet. */
  at: string;
  /** Where the current version came from. */
  source: string;
  /** `8 shots on v2 · 6 held on v1` */
  spread: string;
  versions: VersionRow[];
};

const useOf = (use: ElementUse, attributeId: string): AttributeUse | null =>
  use.attributes.find((a) => a.attributeId === attributeId) ?? null;

const versionUse = (a: AttributeUse | null, versionId: string): VersionUse =>
  a?.versions.find((v) => v.versionId === versionId) ?? { versionId, pinned: 0, takes: 0 };

/**
 * Where a version came from, which is the one thing about it that cannot be
 * derived from anything else and the reason `attribute_versions` carries
 * exactly one of three source columns.
 */
export function sourceOf(v: VersionIn | null, use: ElementUse): string {
  if (!v) return "";
  if (v.identityId) {
    const n = use.photos[v.identityId] ?? 0;
    return n ? `Trained from ${n} photo${n === 1 ? "" : "s"}` : "Trained identity";
  }
  if (v.genId) {
    const shot = use.from[v.genId];
    return shot ? `Promoted from ${shot}` : "Promoted from a take";
  }
  if (v.uploadId) return "Uploaded";
  return "";
}

/**
 * `8 shots on v2 · 6 held on v1`.
 *
 * The two halves are different facts and the sentence keeps them apart: the
 * first is what MOVES when current moves, the second is what stays. A swap
 * costs the first number and does nothing to the second, which is exactly
 * what the impact panel then prices, so a producer can read the consequence
 * here before they open it.
 */
export function spreadOf(a: AttributeIn, use: ElementUse): string {
  const u = useOf(use, a.id);
  if (!u) return "";
  const at = (id: string | null) => {
    const i = a.versions.findIndex((v) => v.id === id);
    return i < 0 ? "" : `v${i + 1}`;
  };
  const parts: string[] = [];
  const now = at(a.currentId);
  if (u.following && now) parts.push(`${u.following} shot${u.following === 1 ? "" : "s"} on ${now}`);

  /* Pinned shots, oldest version first, so the line reads in the order the
     versions were made rather than in whatever order the counts came back. */
  for (const v of a.versions) {
    const n = versionUse(u, v.id).pinned;
    if (n) parts.push(`${n} held on ${at(v.id)}`);
  }
  return parts.join(" · ");
}

export function versionMeta(v: VersionIn, current: boolean, u: VersionUse): string {
  if ((v.status ?? "ready") !== "ready") return "still rendering";
  const parts: string[] = [];
  if (current) parts.push("in use");
  if (u.pinned) parts.push(`${u.pinned} shot${u.pinned === 1 ? "" : "s"}`);
  if (u.takes) parts.push(`${u.takes} take${u.takes === 1 ? "" : "s"}`);
  return parts.join(" · ") || "nothing yet";
}

export function attributeRows(el: ElementIn, use: ElementUse): AttributeRow[] {
  return el.attributes.map((a) => {
    const u = useOf(use, a.id);
    const currentIndex = a.versions.findIndex((v) => v.id === a.currentId);
    const current = currentIndex < 0 ? null : a.versions[currentIndex];
    return {
      id: a.id,
      name: (a.label || a.kind).toUpperCase(),
      kind: a.kind,
      /* The element's own lock reaches every port. A person who locked a
         character did not lock three quarters of one. */
      locked: a.locked || el.locked,
      at: current ? versionLine(currentIndex, current.label) : "",
      source: sourceOf(current, use),
      spread: spreadOf(a, use),
      versions: a.versions.map((v, i) => ({
        id: v.id,
        line: versionLine(i, v.label),
        current: v.id === a.currentId,
        ready: (v.status ?? "ready") === "ready",
        meta: versionMeta(v, v.id === a.currentId, versionUse(u, v.id)),
      })),
    };
  });
}

/* ── What consumes which port ───────────────────────────────────────────── */

export type WiredLine = { stages: string; ports: string; override: boolean };

/**
 * `Keyframes · Motion → FACE · HAIR · WARDROBE`, `Audio → VOICE`.
 *
 * Derived from what each attribute IS rather than from a table of stage
 * names, because the stages a workspace runs are its own — a recipe with no
 * audio stage should not be told its character's voice is wired into one.
 * `stageNames` is what this production actually runs; the split is between
 * the ports a picture consumes and the ports a sound does.
 */
export function wiredInto(
  el: ElementIn,
  stageNames: { visual: string[]; audio: string[] },
  overrides: { shotCode: string; attributeId: string; versionLabel: string }[] = [],
): WiredLine[] {
  const named = (kinds: AttributeIn[]) =>
    kinds.map((a) => (a.label || a.kind).toUpperCase()).join(" · ");

  const visual = el.attributes.filter((a) => isVisual(a.kind as AttributeKind) && a.versions.length);
  const audio = el.attributes.filter((a) => !isVisual(a.kind as AttributeKind) && a.versions.length);

  const out: WiredLine[] = [];
  if (visual.length && stageNames.visual.length) {
    out.push({ stages: stageNames.visual.join(" · "), ports: named(visual), override: false });
  }
  if (audio.length && stageNames.audio.length) {
    out.push({ stages: stageNames.audio.join(" · "), ports: named(audio), override: false });
  }

  /* Every shot that has stepped out of line, named. This is the line the
     screen exists for: an element is only as consistent as the shots that
     did NOT override it. */
  for (const o of overrides) {
    const a = el.attributes.find((x) => x.id === o.attributeId);
    out.push({
      stages: `${o.shotCode} only`,
      ports: `${(a?.label || a?.kind || "").toUpperCase()} ${o.versionLabel}`.trim(),
      override: true,
    });
  }
  return out;
}

/* ── The header, and the two things the footer can do ───────────────────── */

export function usedByLine(el: ElementIn, use: ElementUse): string {
  const kind = el.kind.toUpperCase();
  if (!use.shots) return `${kind} · NOT IN A SHOT YET`;
  return `${kind} · USED BY ${use.shots} SHOT${use.shots === 1 ? "" : "S"}`;
}

/**
 * The rule the whole screen rests on, said once.
 *
 * It used to end "…without leaving the element", which is the handoff's own
 * sentence and is the thing that does not work yet: with one binding row per
 * slot an override REPLACES the element, so pinning a coat drops the face.
 * The key is being widened to fix that (SOW section 9), and until it is, the
 * screen says what is true rather than what is intended — a product that
 * describes a behaviour it does not have is worse than one that says less.
 */
export const RULE =
  "Any prompt citing this element gets these versions. A shot can pin one attribute to an older version of its own.";

export function lockLabel(el: ElementIn): string {
  return el.locked ? "Unlock" : "Lock";
}

export function lockNote(el: ElementIn): string {
  return el.locked
    ? "Locked. Nothing can change which version a shot inherits until it is unlocked."
    : "Lock it and no stage, scene or shot can move it.";
}

/**
 * The primary.
 *
 * Adding a version is free where the material already exists — an upload, or
 * a take that has already been paid for — and priced only where it would
 * render something new. The handoff prices it flat at 12 cr; that is the
 * rendering case, and quoting it on a screen where the person is about to
 * attach a photograph they already own would be charging for nothing.
 */
export function addLabel(credits: number | null): string {
  return credits == null || credits <= 0 ? "Add a version" : `Add a version · ${credits} cr`;
}

export const ADD_NOTE =
  "A new version never changes an existing take. Swapping which one is current is what costs, and it asks first.";

/** Which element kinds have anything worth showing on this screen. */
export function hasPorts(el: ElementIn): boolean {
  return el.attributes.some((a) => a.versions.length > 0);
}

export function kindWord(kind: string): string {
  return (kind as ElementKind) === "look" ? "look" : kind;
}

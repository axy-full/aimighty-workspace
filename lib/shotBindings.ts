import { SLOTS, SLOT_LABELS, slotFor, versionLine, versionNumber, type ElementKind, type Slot } from "./rig";

/**
 * One shot's five slots, and what changing one of them means
 * (brief 3, surface 2c).
 *
 * Everything here is a pure function of rows that are already in front of it.
 * The surface is the only place a person changes a binding on ONE shot rather
 * than on the library, so it is the only place where the answer to "what does
 * this reach" is a single shot — which is why it does not open the impact
 * panel and does not need to. The price still has to be on the button, so it
 * is quoted the same way the panel quotes, one shot wide.
 */

/* ── What a row says about itself ───────────────────────────────────────── */

export const BADGES = ["changed", "locked", "override", "created"] as const;
export type Badge = (typeof BADGES)[number];

export const BADGE_LABELS: Record<Badge, string> = {
  changed: "CHANGED", locked: "LOCKED", override: "OVERRIDE", created: "CREATED",
};

/**
 * The order badges are read in, and it is an argument rather than a
 * preference.
 *
 * The handoff draws one badge per row, and on a row that is genuinely two
 * things at once — an overridden slot on a locked element — one badge has to
 * win. It sorts by what a person can DO about the row, not by what is most
 * interesting about it:
 *
 *   changed   an edit is sitting in front of you, unsaved, with a price
 *   locked    you cannot act on this row at all, so nothing else matters yet
 *   override  this shot differs from every other, which is a thing to fix
 *   created   the row's history, which asks nothing of anybody
 *
 * A phone shows badges[0] because there is no room for two. A desktop shows
 * them all: it is where the wiring is done and dropping a fact to save 60px
 * on a 1440-wide screen is a loss with nothing bought.
 */
const RANK: Record<Badge, number> = { changed: 0, locked: 1, override: 2, created: 3 };

export function orderBadges(badges: Badge[]): Badge[] {
  return [...new Set(badges)].sort((a, b) => RANK[a] - RANK[b]);
}

/* ── The rows ───────────────────────────────────────────────────────────── */

export type VersionIn = { id: string; label: string; status?: string | null };

export type AttributeIn = {
  id: string;
  kind: string;
  label: string;
  currentId: string | null;
  locked: boolean;
  versions: VersionIn[];
};

export type ElementIn = {
  id: string;
  kind: string;
  name: string;
  description?: string;
  locked: boolean;
  fromShotId: string | null;
  attributes: AttributeIn[];
};

export type BindingIn = {
  slot: Slot;
  ordinal: number;
  elementId: string;
  attributeId: string | null;
  versionId: string | null;
};

export type RowVersion = {
  id: string;
  /** `v2 overalls` — the number is the position, so it cannot drift. */
  line: string;
  current: boolean;
  /**
   * Pinned by THIS shot. Deliberately false on a row that follows current,
   * even though one tile does happen to hold the current version: following
   * is a choice about the LIBRARY, and lighting a tile as well would give one
   * choice two selected states and no way to tell which is in force.
   */
  inUse: boolean;
  ready: boolean;
};

export type BundlePort = {
  id: string;
  label: string;
  /** `v3` — where this attribute stands FOR THIS SHOT, pin included. */
  at: string;
  locked: boolean;
  /** The version this shot has pinned the port to, if it has. */
  pinned: string | null;
  versions: VersionIn[];
};

export type Row = {
  slot: Slot;
  label: string;
  ordinal: number;
  /** Null on a slot nothing is bound to, which is a row and not an absence. */
  elementId: string | null;
  attributeId: string | null;
  name: string;
  detail: string;
  badges: Badge[];
  locked: boolean;
  /** The versions offered when the row is expanded. Empty on a bundle row. */
  versions: RowVersion[];
  /**
   * A bundle row's ports, so one attribute can be overridden without the shot
   * leaving the element — which is the handoff's own sentence about 2c and the
   * whole reason the CHARACTER row is interesting.
   *
   * They are offered as a SECOND step rather than flattened into versions.
   * The first draft flattened them, by quietly adopting the element's first
   * attribute as the row's own; picking anything then rewrote a bundle port
   * into a face-only one and dropped hair, wardrobe and voice off the shot
   * without saying so. Narrowing is a decision, so it is a choice a person
   * makes on purpose.
   */
  bundle: BundlePort[];
  /** What this row was before the unsaved edit, when there is one. */
  wasLine: string;
};

/** The effective version of one attribute on this shot: pinned wins, else current. */
export function effectiveVersion(a: AttributeIn, pinned: string | null): VersionIn | null {
  const wanted = pinned ?? a.currentId;
  return a.versions.find((v) => v.id === wanted) ?? null;
}

const numberOf = (a: AttributeIn, versionId: string | null): string => {
  const i = a.versions.findIndex((v) => v.id === versionId);
  return i < 0 ? "" : versionNumber(i);
};

/**
 * The line under an element's name.
 *
 * Derived rather than written per slot, because a per-slot sentence is a
 * sentence about one studio's production and rule 3 does not allow one. An
 * element with several attributes reads as its attributes; an element with
 * one reads as which of its versions this shot took.
 */
export function detailOf(
  el: ElementIn, b: BindingIn, shotId: string, overrides: BindingIn[] = [],
): string {
  if (el.fromShotId && el.fromShotId === shotId) return "created here";

  const visible = el.attributes.filter((a) => a.versions.length > 0);
  if (!visible.length) return (el.description ?? "").trim();

  /* A binding that names an attribute reaches exactly that one, so reading
     out the others would describe versions this shot never asked for. */
  if (b.attributeId) {
    const a = visible.find((x) => x.id === b.attributeId);
    if (!a) return "";
    const at = numberOf(a, b.versionId ?? a.currentId);
    return a.versions.length > 1
      ? `${at || "—"} of ${a.versions.length} ${plural(a.label || a.kind, a.versions.length)}`
      : `${a.label || a.kind} ${at}`.trim();
  }

  if (visible.length === 1) {
    const a = visible[0];
    const at = numberOf(a, a.currentId);
    return `${at || "—"} of ${a.versions.length} ${plural(a.label || a.kind, a.versions.length)}`;
  }

  /* The bundle: every attribute at the version THIS SHOT gets — current,
     unless the shot has pinned that port to something older, which is now a
     row of its own on the same slot. Reading current for all of them would
     describe the library rather than the shot, and the whole promise of the
     screen is that it describes the shot. */
  return visible
    .map((a) => {
      const over = overrides.find((o) => o.attributeId === a.id) ?? null;
      const at = numberOf(a, over?.versionId ?? a.currentId) || "—";
      return `${(a.label || a.kind).toLowerCase()} ${at}${over?.versionId ? "*" : ""}`;
    })
    .join(" · ");
}

function plural(word: string, n: number): string {
  const w = word.trim().toLowerCase() || "version";
  if (n === 1) return w;
  return /s$/.test(w) ? w : `${w}s`;
}

/** A row's address. A slot alone is not one: a shot can hold two characters. */
export const rowKey = (slot: Slot, ordinal: number): string => `${slot}:${ordinal}`;

/**
 * A WIRE's address, which is a row's plus the attribute.
 *
 * Since the key was widened a row can carry several wires — the bundle, and
 * an override per attribute — so pending edits are keyed by this rather than
 * by the row. Keyed by the row, an override would have overwritten the
 * bundle's pending entry, which is the same mistake the schema used to make.
 */
export const wireKey = (slot: Slot, ordinal: number, attributeId: string | null): string =>
  `${slot}:${ordinal}:${attributeId ?? ""}`;

/**
 * The rows, in the handoff's order, whether or not anything is bound.
 *
 * **One row per (slot, ordinal), not one per slot.** The handoff draws five
 * rows because its shot holds one of each, and reading that as "a slot has one
 * binding" would drop the second character of any two-hander on the floor —
 * the shot would render with it and the screen would never say so. `ordinal`
 * exists on the binding for exactly this, and rule 6 is that a wire lands on a
 * slot rather than on a node. A slot with nothing bound still gets its empty
 * row, because an empty slot is where a wire goes next.
 *
 * `changed` carries whatever is unsaved in the surface, keyed by rowKey(). It
 * is passed in rather than diffed here against a mutated copy, so that the
 * saved binding and the pending one are never the same object and a badge
 * cannot be lost to an edit in place.
 */
export function rowsOf(
  shotId: string,
  bindings: BindingIn[],
  elements: ElementIn[],
  changed: Record<string, BindingIn> = {},
): Row[] {
  const byId = new Map(elements.map((e) => [e.id, e]));

  const pairs: { slot: Slot; ordinal: number }[] = [];
  for (const slot of SLOTS) {
    const ordinals = [...new Set([
      ...bindings.filter((b) => b.slot === slot).map((b) => b.ordinal),
      ...Object.values(changed).filter((b) => b && b.slot === slot).map((b) => b.ordinal),
    ])].sort((a, b) => a - b);
    /* Nothing bound is still one row. Something bound gets a row each, and no
       empty row after it: an "add another" is a different control from a slot
       that has never been filled, and this surface does not add ports. */
    pairs.push(...(ordinals.length ? ordinals.map((ordinal) => ({ slot, ordinal })) : [{ slot, ordinal: 0 }]));
  }

  return pairs.map(({ slot, ordinal }) => {
    /* The BUNDLE is the row's identity; overrides on the same address qualify
       it. Taking whichever binding came back first made the row report itself
       as a wardrobe when the shot was citing a whole character. */
    const here = bindings.filter((b) => b.slot === slot && b.ordinal === ordinal);
    const saved = here.find((b) => !b.attributeId) ?? here[0] ?? null;
    const pinnedHere = here.filter((b) => b.attributeId);
    /* The row's own pending edit is the one on the wire the row IS. Usually
       that is the bundle; on a slot bound straight to one attribute — a
       background pinned to a plate, with no bundle above it — the row is that
       override, and reading the bundle's address would have shown the saved
       version while the person was looking at the one they had just picked.
       A pending edit on any OTHER wire is a port, and shows up there. */
    const rowWire = saved?.attributeId ?? null;
    const pending = changed[wireKey(slot, ordinal, rowWire)] ?? null;
    const pendingPorts = Object.entries(changed)
      .filter(([k, v]) => v && k.startsWith(`${slot}:${ordinal}:`) && v.attributeId
                          && v.attributeId !== rowWire)
      .map(([, v]) => v);
    /* Only the ones that actually LAND somewhere else. Re-picking what a port
       is already pinned to is not a change and must not price — the same rule
       the row's own wire has, applied to the wires beside it. */
    const movedPorts = pendingPorts.filter(
      (v) => !sameBinding(v, here.find((x) => x.attributeId === v.attributeId) ?? null));
    const b = pending ?? saved;
    /* The label carries the ordinal only when there is more than one, so the
       common shot reads exactly as the handoff draws it. */
    const many = pairs.filter((p) => p.slot === slot).length > 1;
    const base: Row = {
      slot, label: many ? `${SLOT_LABELS[slot]} ${ordinal + 1}` : SLOT_LABELS[slot], ordinal,
      elementId: null, attributeId: null, name: "", detail: "",
      badges: [], locked: false, versions: [], bundle: [], wasLine: "",
    };
    if (!b) return base;

    const el = byId.get(b.elementId);
    if (!el) return base;

    const attr = b.attributeId ? el.attributes.find((a) => a.id === b.attributeId) ?? null : null;
    const locked = el.locked || (attr?.locked ?? false);

    const badges: Badge[] = [];
    /* An unsaved edit is only a change if it actually lands somewhere else.
       Re-picking what is already bound is not a change and must not price. */
    if ((pending && !sameBinding(pending, saved)) || movedPorts.length) badges.push("changed");
    if (locked) badges.push("locked");
    /* Pinned: this shot names a version, so it will not follow the library.
       That is the whole of what OVERRIDE means and the whole of what draws
       the ink wire on the canvas. */
    if (b.versionId || pinnedHere.some((x) => x.versionId) || pendingPorts.some((x) => x.versionId)) {
      badges.push("override");
    }
    if (el.fromShotId && el.fromShotId === shotId) badges.push("created");

    /* A bundle stays a bundle. `attributeId: null` means every attribute at
       its current version, and falling back to the element's FIRST attribute
       here was silently rewriting the port: expanding a bundle row and
       picking anything saved a single-attribute pin, dropping the other three
       ports off the shot without a word. A bundle therefore offers no version
       tiles — there is no one version to offer — and its detail line already
       reads out every attribute. Changing what a bundle follows is the
       library's act, on the element's own screen. */
    const source = attr;
    const versions: RowVersion[] = source
      ? source.versions.map((v, i) => ({
          id: v.id,
          /* The shared one, not a second copy of it. A separator or a
             truncation changed in lib/rig.ts has to reach the version tiles
             here at the same moment it reaches the canvas and the backfill
             report, or one version reads two ways in one product. */
          line: versionLine(i, v.label),
          current: v.id === source.currentId,
          inUse: b.versionId ? v.id === b.versionId : false,
          ready: (v.status ?? "ready") === "ready",
        }))
      : [];

    /* Only on a bundle: a row already pointing at one attribute has nothing
       to narrow, and offering the others would be a different act (rebinding
       the slot) wearing the same control. */
    const bundle: BundlePort[] = b.attributeId ? [] : el.attributes
      .filter((a) => a.versions.length > 0)
      .map((a) => {
        /* An override on this port is a SEPARATE row on the same slot now, so
           the port reads its own pin rather than the bundle's absence of one. */
        /* Unsaved beats saved: a port the person has just pinned reads as
           pinned before it is written, which is what makes CHANGED mean
           anything on the row above it. */
        const over = pendingPorts.find((x) => x.attributeId === a.id)
          ?? pinnedHere.find((x) => x.attributeId === a.id) ?? null;
        return {
          id: a.id,
          label: (a.label || a.kind).toLowerCase(),
          at: numberOf(a, over?.versionId ?? a.currentId) || "—",
          locked: a.locked,
          pinned: over?.versionId ?? null,
          versions: a.versions,
        };
      });

    return {
      ...base,
      elementId: el.id,
      /* The port as STORED. Null on a bundle, and it stays null until somebody
         narrows it on purpose. */
      attributeId: b.attributeId,
      name: el.name,
      detail: detailOf(el, b, shotId, [...pinnedHere.filter(
        (x) => !pendingPorts.some((p) => p.attributeId === x.attributeId)), ...pendingPorts]),
      badges: orderBadges(badges),
      locked,
      versions,
      bundle,
      wasLine: pending && saved ? wasLineOf(el, saved) : "",
    };
  });
}

/**
 * The elements a slot can take, which is the only way an empty slot is ever
 * filled: this route is the product's only writer of bindings, so a surface
 * that could re-point but not bind would have shown five empty rows on every
 * real workspace and been unable to do anything about any of them.
 *
 * `keyframe` deliberately offers nothing. A keyframe is a frame of this shot's
 * own take rather than a member of the library, so there is no element to
 * bind; the row states what it is and stays empty until the take exists.
 */
export function candidatesFor(slot: Slot, elements: ElementIn[], bound: Set<string>): ElementIn[] {
  if (slot === "keyframe") return [];
  return elements
    .filter((e) => slotFor(e.kind as ElementKind) === slot && !e.locked && !bound.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether the row's selection is "follow current" rather than any one tile. */
export function follows(row: Row): boolean {
  return !row.versions.some((v) => v.inUse);
}

/**
 * What the row was, for a row that has been changed but not saved.
 *
 * The handoff's own behaviour: picking a different plate flips the detail to
 * `changed from plate 01`. Without it a CHANGED badge says only that
 * something moved, and the one question a person asks next — moved from
 * what? — has no answer on the screen.
 */
export function wasLineOf(el: ElementIn, saved: BindingIn): string {
  if (!saved.versionId) {
    return saved.attributeId ? "was following current" : "was the whole element";
  }
  const a = el.attributes.find((x) => x.id === saved.attributeId);
  if (!a) return "";
  const i = a.versions.findIndex((v) => v.id === saved.versionId);
  return i < 0 ? "" : `was ${versionLine(i, a.versions[i].label)}`;
}

export function sameBinding(a: BindingIn | null, b: BindingIn | null): boolean {
  if (!a || !b) return a === b;
  return a.elementId === b.elementId
    && (a.attributeId ?? null) === (b.attributeId ?? null)
    && (a.versionId ?? null) === (b.versionId ?? null)
    && a.ordinal === b.ordinal;
}

/* ── What the change costs, said before it is made ──────────────────────── */

/**
 * The sentence above the footer.
 *
 * Saving a binding changes nothing that already exists — the approved take
 * was made from the old version and stays made from it — so the sentence has
 * to separate the two, or the footer's `0 cr` reads as a lie and the price
 * of the re-render reads as a surprise. `credits` is what re-rendering this
 * one shot would cost, quoted, not multiplied.
 */
export function consequenceOf(
  rows: Row[], credits: number, approved: boolean,
): string {
  const changed = rows.filter((r) => r.badges.includes("changed"));
  if (!changed.length) {
    return approved
      ? "THIS SHOT'S APPROVED TAKE STANDS. CHANGE A SLOT AND ONLY THIS SHOT MOVES."
      : "FIVE SLOTS, EACH POINTING AT A VERSION IN THE LIBRARY.";
  }
  const what = changed.map((r) => r.label).join(" · ");
  return approved
    ? `${what} CHANGED · THE APPROVED TAKE KEEPS THE OLD VERSION UNTIL THIS SHOT IS RENDERED AGAIN · ${credits} CR`
    : `${what} CHANGED · THE NEXT TAKE OF THIS SHOT USES IT · ${credits} CR`;
}

/** The footer's primary. Saving costs nothing; only a render does. */
export function saveLabel(rows: Row[]): string {
  const n = rows.filter((r) => r.badges.includes("changed")).length;
  return n === 0 ? "Nothing to save" : n === 1 ? "Save this change" : `Save ${n} changes`;
}

/**
 * What rendering this shot again would cost — a statement, not a button.
 *
 * Rig's first rule is that the price is on the action, quoted before the
 * button enables. This surface has no render button, so what it owes is the
 * figure itself: a person changing a plate is deciding whether it is worth
 * forty credits, and they must be able to see the forty before they decide.
 * When the verdict refuses, the number stops being the useful fact — the
 * reason is — so the line says that instead of quoting a spend that would be
 * turned away.
 */
export function renderPrice(credits: number, allow = true): string {
  return allow ? `Rendering it again · ${credits} cr` : "Can't render yet · see above";
}

/** What an empty row says when there is nothing it could ever hold. */
export function emptyNote(slot: Slot, candidates: number): string {
  if (slot === "keyframe") {
    return "A keyframe is a frame of this shot's own take, not something from the library.";
  }
  return candidates
    ? "Nothing bound. Pick one to wire it in."
    : `No ${slot === "background" ? "location" : slot === "element" ? "prop" : slot} in this project yet.`;
}

/**
 * A locked slot cannot be changed here, and saying so once is cheaper than a
 * disabled control a person taps three times before believing it.
 */
export function lockNote(row: Row): string {
  return row.locked
    ? `${row.name} is locked. Unlock it in the library to change this slot.`
    : "";
}

/** `3 versions`, and `1 version`. */
export function countLine(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** What the take strip reads, when there is a take to read. */
export function takeLine(
  take: { version: number; state?: string; approved: boolean; seconds: number | null; credits: number } | null,
): string {
  if (!take) return "NO TAKE YET";
  /* draft -> picked -> approved is the product's vocabulary (SOW rule 4), and
     a picked take called a draft loses the one state a producer set by hand. */
  const state = take.approved ? "APPROVED" : (take.state || "").toLowerCase() === "picked" ? "PICKED" : "DRAFT";
  const bits = [`v${take.version}`, state];
  if (take.seconds != null && take.seconds > 0) bits.push(secondsLine(take.seconds));
  bits.push(`${take.credits} CR`);
  return bits.join(" · ");
}

export function secondsLine(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Elements this shot put into the library, which is the last card on the surface. */
export function madeHere(elements: ElementIn[], shotId: string): ElementIn[] {
  return elements.filter((e) => e.fromShotId === shotId);
}

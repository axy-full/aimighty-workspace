import { BEAT_LIMITS, newScene, newShot, removeFromSheet, restoreToSheet, type BeatRemoval, type BeatSheet, type BeatShot } from "@/lib/production/beats";
import type { Project } from "@/lib/workbench/studio";

/*
 * The board's two documents (design/particl-graphite/README.md § 3.1 d, § 1.2):
 *  - the brief, as a document card on the board;
 *  - the shot list, as the board's List view.
 *
 * Both read the project draft as it is today: the brief, the creative direction, the aspect and frame
 * rate, and the beat sheet's shots (production.beats). Nothing here fetches or remembers anything.
 * Edits are pure Project → Project functions. The board applies them through the Rig seam
 * (ctx.rig.apply), so the draft saves itself and merges like every other edit.
 */

/** The draft's own limits on these fields (lib/workbench/studio-schema.ts). */
export const DOC_LIMITS = { brief: 30_000, direction: 30_000 } as const;

/** Whole seconds read as "4 s"; halves as "4.5 s". */
export function seconds(value: number): string {
  return `${Math.round(value * 10) / 10} s`;
}

/** A running time: "15 s" under a minute, "1:30" from a minute on. */
export function runningTime(value: number): string {
  if (value < 60) return seconds(value);
  return clock(value);
}

/** Where a shot starts, as a timecode: "0:04". Seconds round down, so a shot never starts early on paper. */
export function clock(value: number): string {
  const whole = Math.max(0, Math.floor(value + 1e-9));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/* ── The brief document ──────────────────────────────────────────────── */

export type BriefDoc = {
  title: string;
  /** What we are making: the draft's brief. */
  brief: string;
  /** The look: the draft's creative direction. */
  look: string;
  /** "16:9 · 24 fps · 15 s": aspect, frame rate, and the running time when every shot has a length. */
  footer: string;
  /** The Brief region on the rail. */
  state: "done" | "empty";
  summary: string;
};

/** Every shot's length in seconds, or null when a shot has none (a total would be short). */
export function sheetLength(sheet: BeatSheet | null | undefined): number | null {
  const shots = (sheet?.scenes ?? []).flatMap((scene) => scene.shots);
  if (!shots.length || shots.some((shot) => !shot.duration)) return null;
  return shots.reduce((sum, shot) => sum + (shot.duration ?? 0), 0);
}

export function briefDoc(project: Project): BriefDoc {
  const length = sheetLength(project.production?.beats);
  const filled = Boolean(project.brief.trim() || project.direction.trim());
  return {
    title: project.name,
    brief: project.brief,
    look: project.direction,
    footer: [project.aspect, `${project.fps} fps`, length != null ? runningTime(length) : null].filter(Boolean).join(" · "),
    state: filled ? "done" : "empty",
    summary: filled ? "Brief · 1 document" : "Nothing yet",
  };
}

/** The brief card's width on the board (the master's 220). */
export const BRIEF_DOC_WIDTH = 220;

/**
 * The brief card's height before it renders (the board lays cards out from their sizes): its paragraphs at the
 * card's measure (about 22 characters a line at 15 px, 24 px a line; the title about 15 at 22 px, 27 px a line),
 * clamped to 200–720. Longer words scroll inside the card.
 */
export function briefDocHeight(doc: Pick<BriefDoc, "title" | "brief" | "look" | "footer">): number {
  const lines = (text: string, perLine: number) => text.split("\n").reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
  const height = 2 + 18 + 16 + 10 + lines(doc.title || " ", 15) * 27 + 10 + lines(doc.brief || " ", 22) * 24
    + 10 + 16 + 4 + lines(doc.look || " ", 22) * 24 + (doc.footer ? 10 + 20 : 0) + 18;
  return Math.min(720, Math.max(200, Math.ceil(height)));
}

export type BriefField = "brief" | "direction";

/** The draft with one brief field replaced, cut to the draft's limit; unchanged when it is already that. */
export function withBriefField(project: Project, field: BriefField, value: string): Project {
  const next = value.slice(0, DOC_LIMITS[field]);
  return project[field] === next ? project : { ...project, [field]: next };
}

/* ── The shot list ───────────────────────────────────────────────────── */

export type ShotRow = {
  id: string;
  sceneId: string;
  /** 1-based, across the whole film. */
  index: number;
  /** "01" */
  n: string;
  /** Seconds from the top, or null once a shot before it has no length. */
  start: number | null;
  duration: number | null;
  /** "0:04 · 6 s", or "6 s" when its start is unknown, or "" when it has no length. */
  time: string;
  /** What the camera sees. */
  action: string;
  /** Framing: "Extreme wide". */
  size: string;
  /** Movement, and the lens when it is written there: "Slow push · 35mm". */
  camera: string;
  light: string;
  sound: string;
};

export function shotRows(sheet: BeatSheet | null | undefined): ShotRow[] {
  const rows: ShotRow[] = [];
  let at: number | null = 0;
  for (const scene of sheet?.scenes ?? []) {
    for (const shot of scene.shots) {
      const index = rows.length + 1;
      const duration = shot.duration ?? null;
      const start = at;
      rows.push({
        id: shot.id, sceneId: scene.id, index, n: String(index).padStart(2, "0"), start, duration,
        time: duration == null ? "" : start == null ? seconds(duration) : `${clock(start)} · ${seconds(duration)}`,
        action: shot.description, size: shot.framing, camera: shot.movement, light: shot.lighting, sound: shot.sound,
      });
      at = at == null || duration == null ? null : at + duration;
    }
  }
  return rows;
}

/** The fields a row edits in place, with the beat sheet's own limits. */
export type ShotField = "description" | "framing" | "movement" | "lighting" | "sound";
const FIELD_LIMIT: Record<ShotField, number> = {
  description: BEAT_LIMITS.description, framing: BEAT_LIMITS.field, movement: BEAT_LIMITS.field, lighting: BEAT_LIMITS.field, sound: BEAT_LIMITS.field,
};

/** The draft with one shot changed (found in any scene), stamped `now`; unchanged when the shot is gone or nothing changed. */
function withShot(project: Project, shotId: string, now: string, change: (shot: BeatShot) => BeatShot): Project {
  const sheet = project.production?.beats;
  if (!sheet) return project;
  let changed = false;
  const scenes = sheet.scenes.map((scene) => {
    if (!scene.shots.some((shot) => shot.id === shotId)) return scene;
    return {
      ...scene,
      shots: scene.shots.map((shot) => {
        if (shot.id !== shotId) return shot;
        const next = change(shot);
        if (next !== shot) changed = true;
        return next;
      }),
    };
  });
  return changed ? { ...project, production: { ...project.production, beats: { ...sheet, scenes, updatedAt: now } } } : project;
}

export function withShotField(project: Project, shotId: string, field: ShotField, value: string, now: string): Project {
  const next = value.slice(0, FIELD_LIMIT[field]);
  return withShot(project, shotId, now, (shot) => (shot[field] === next ? shot : { ...shot, [field]: next }));
}

/** A shot's length, 0.5 to 600 seconds (the beat sheet's range), or none. Anything else is ignored. */
export function withShotDuration(project: Project, shotId: string, value: number | null, now: string): Project {
  if (value !== null && !Number.isFinite(value)) return project;
  const next = value === null ? undefined : Math.min(600, Math.max(0.5, Math.round(value * 2) / 2));
  return withShot(project, shotId, now, (shot) => {
    if (shot.duration === next) return shot;
    const { duration: _gone, ...rest } = shot;
    void _gone;
    return next === undefined ? rest : { ...rest, duration: next };
  });
}

/**
 * The draft with one empty shot at the end of the last scene, and its id. With no beat sheet yet, it
 * starts one (stamped with `scriptSha256`, the hash of the script as it is now, as Beats does). A last
 * scene that is full gets a new scene after it. Null when the sheet holds all the scenes it may.
 */
export function withNewShot(project: Project, scriptSha256: string, now: string): { project: Project; id: string } | null {
  const sheet = project.production?.beats;
  if (!sheet) {
    const scene = newScene();
    const fresh: BeatSheet = { scriptSha256, updatedAt: now, scenes: [scene] };
    return { project: { ...project, production: { ...project.production, beats: fresh } }, id: scene.shots[0].id };
  }
  const last = sheet.scenes[sheet.scenes.length - 1];
  if (last && last.shots.length < BEAT_LIMITS.shots) {
    const shot = newShot();
    const scenes = sheet.scenes.map((scene) => (scene === last ? { ...scene, shots: [...scene.shots, shot] } : scene));
    return { project: { ...project, production: { ...project.production, beats: { ...sheet, scenes, updatedAt: now } } }, id: shot.id };
  }
  if (sheet.scenes.length >= BEAT_LIMITS.scenes) return null;
  const scene = newScene();
  return { project: { ...project, production: { ...project.production, beats: { ...sheet, scenes: [...sheet.scenes, scene], updatedAt: now } } }, id: scene.shots[0].id };
}

/** The draft without one shot, and what it took (for Undo); null when the shot is not there. */
export function withoutShot(project: Project, shotId: string, now: string): { project: Project; removal: BeatRemoval } | null {
  const sheet = project.production?.beats;
  const scene = sheet?.scenes.find((s) => s.shots.some((shot) => shot.id === shotId));
  if (!sheet || !scene) return null;
  const taken = removeFromSheet(sheet, { kind: "shot", sceneId: scene.id, id: shotId });
  if (!taken) return null;
  return { project: { ...project, production: { ...project.production, beats: { ...taken.sheet, updatedAt: now } } }, removal: taken.removal };
}

/** Undo of withoutShot: the shot back at its place. Null when it cannot go back (its scene is gone, or the scene is full). */
export function withShotBack(project: Project, removal: BeatRemoval, now: string): Project | null {
  const sheet = project.production?.beats;
  const next = restoreToSheet(sheet, removal);
  if (!next) return null;
  if (next === sheet) return project;
  return { ...project, production: { ...project.production, beats: { ...next, updatedAt: now } } };
}

/** A canvas brief card's text, cut to the draft's limit; unchanged when the card is gone, locked, or already says it. */
export function withNodeText(project: Project, nodeId: string, value: string): Project {
  const next = value.slice(0, 30_000);
  const node = project.nodes.find((n) => n.id === nodeId);
  if (!node || node.locked || (node.text ?? "") === next) return project;
  return { ...project, nodes: project.nodes.map((n) => (n.id === nodeId ? { ...n, text: next } : n)) };
}

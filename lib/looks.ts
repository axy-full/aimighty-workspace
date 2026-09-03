/**
 * Looks — the studio's style library.
 *
 * Higgsfield's Soul is a stills model with a curated, named, visual library
 * of presets on top, and Moodboards for a style of your own. Ours is built
 * on what Particl already had: a Look is a saved set of shot-control chips,
 * now with a category, a cover, a short blurb, a style BLOCK written in the
 * craft bank's own rigorous register, and optionally a handful of reference
 * stills that ride along with every render made in that Look.
 *
 * Two honest mechanisms, and only two. Words: the block composes into the
 * prompt deterministically, costs nothing, and works on every engine.
 * Pictures: the references are attached exactly as a person's own would be,
 * which both engine families accept. Nothing here is a fine-tune, and
 * nothing pretends to be.
 *
 * Twenty Looks ship with the product, workspace-wide and read-only; a team
 * duplicates one to make it theirs, or saves a new one from the composer.
 * A shipped Look's cover is, wherever possible, a real render the team
 * approved in that Look — the library becomes a record of taste.
 */
import { db, ready, now, id as newId } from "./db";
import { CATEGORIES, type ShotSpec } from "./studio";

export type Look = {
  id: string;
  slug: string | null;
  projectId: string | null;          // null = the whole workspace
  name: string;
  category: string;
  blurb: string;
  spec: ShotSpec;
  /** The style block, in the bank's register. Empty means chips only. */
  prose: string;
  /** Upload ids of reference stills carried into every render. */
  refs: string[];
  coverGenId: string | null;
  coverUploadId: string | null;
  /** Two colours, for the tile before a real cover exists. */
  swatch: [string, string];
  builtin: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export const LOOK_CATEGORIES = [
  "Editorial", "Commercial", "Documentary", "Beauty", "Product",
  "Night", "Film stock", "Analogue", "Motion", "Custom",
] as const;

export const MAX_LOOK_REFS = 6;

/** Only keys and values the chip system knows survive. */
export function cleanSpec(input: unknown): ShotSpec {
  const out: ShotSpec = {};
  if (!input || typeof input !== "object") return out;
  for (const c of CATEGORIES) {
    const v = (input as Record<string, unknown>)[c.key];
    if (typeof v === "string" && c.options.some((o) => o.value === v)) out[c.key] = v;
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function rowToLook(r: any): Look {
  let spec: ShotSpec = {};
  try { spec = cleanSpec(JSON.parse(r.spec || "{}")); } catch { /* unreadable spec = no chips */ }
  let refs: string[] = [];
  try { const j = JSON.parse(r.refs || "[]"); if (Array.isArray(j)) refs = j.filter((x) => typeof x === "string"); } catch { /* none */ }
  let swatch: [string, string] = ["#D9DBE0", "#8A8E96"];
  try { const j = JSON.parse(r.swatch || "null"); if (Array.isArray(j) && j.length === 2) swatch = [String(j[0]), String(j[1])]; } catch { /* default */ }
  return {
    id: r.id,
    slug: r.slug ?? null,
    projectId: r.project_id ?? null,
    name: r.name,
    category: r.category || "Custom",
    blurb: r.blurb ?? "",
    spec,
    prose: r.prose ?? "",
    refs,
    coverGenId: r.cover_gen_id ?? null,
    coverUploadId: r.cover_upload_id ?? null,
    swatch,
    builtin: Boolean(Number(r.builtin ?? 0)),
    createdBy: r.created_by ?? "",
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at ?? r.created_at),
  };
}

export async function getLook(id: string): Promise<Look | null> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM shot_presets WHERE id = ? LIMIT 1`, args: [id] });
  return rs.rows[0] ? rowToLook(rs.rows[0]) : null;
}

/** The Looks a project can use: its own, plus everything workspace-wide. */
export async function listLooks(projectId: string | null): Promise<Look[]> {
  await ready();
  await ensureBuiltinLooks();
  const rs = projectId
    ? await db().execute({
        sql: `SELECT * FROM shot_presets WHERE project_id = ? OR project_id IS NULL
              ORDER BY builtin DESC, category, LOWER(name)`,
        args: [projectId],
      })
    : await db().execute(
        `SELECT * FROM shot_presets WHERE project_id IS NULL ORDER BY builtin DESC, category, LOWER(name)`
      );
  return rs.rows.map(rowToLook);
}

/**
 * Where a Look's cover comes from, in order: the render or upload somebody
 * chose; else the newest APPROVED render made in this Look; else the newest
 * render made in it at all; else nothing, and the tile wears its swatch.
 */
export type Cover = { url: string; kind: "image" | "video"; genId?: string } | null;

export async function coversFor(looks: Look[]): Promise<Map<string, Cover>> {
  const out = new Map<string, Cover>();
  if (!looks.length) return out;

  const chosenGen = looks.map((l) => l.coverGenId).filter(Boolean) as string[];
  const genKinds = new Map<string, "image" | "video">();
  if (chosenGen.length) {
    const rs = await db().execute({
      sql: `SELECT id, kind FROM generations WHERE id IN (${chosenGen.map(() => "?").join(",")})
            AND status='succeeded' AND stored_url IS NOT NULL AND deleted = 0`,
      args: chosenGen,
    });
    for (const r of rs.rows as any[]) genKinds.set(r.id, r.kind === "image" ? "image" : "video");
  }

  // One pass over renders made in any Look: approved first, then newest.
  const made = new Map<string, { id: string; kind: "image" | "video" }>();
  const rs = await db().execute(`
    SELECT id, kind, json_extract(params, '$.look.id') AS look_id
    FROM generations
    WHERE status='succeeded' AND stored_url IS NOT NULL AND deleted = 0
      AND json_extract(params, '$.look.id') IS NOT NULL
    ORDER BY (review_state = 'approved') DESC, created_at DESC`);
  for (const r of rs.rows as any[]) {
    if (!made.has(r.look_id)) made.set(r.look_id, { id: r.id, kind: r.kind === "image" ? "image" : "video" });
  }

  for (const l of looks) {
    if (l.coverGenId && genKinds.has(l.coverGenId)) {
      out.set(l.id, { url: `/api/media/${l.coverGenId}`, kind: genKinds.get(l.coverGenId)!, genId: l.coverGenId });
    } else if (l.coverUploadId) {
      out.set(l.id, { url: `/api/uploads/${l.coverUploadId}`, kind: "image" });
    } else {
      const m = made.get(l.id);
      out.set(l.id, m ? { url: `/api/media/${m.id}`, kind: m.kind, genId: m.id } : null);
    }
  }
  return out;
}

/** The style block as it joins a prompt: one paragraph, its own sentences. */
export function lookBlock(look: Look): string {
  return look.prose.trim().replace(/\s+/g, " ");
}

/* ── The shipped library ─────────────────────────────────────────────────
 * Craft only: light, lens, grade, palette, texture, motion feel. Never a
 * subject, a wardrobe, a prop or a place — those are the author's. Each
 * block is written the way the bank writes: what the light IS, what the
 * grade DOES, and then it stops.
 * -------------------------------------------------------------------- */
type Builtin = {
  slug: string; name: string; category: (typeof LOOK_CATEGORIES)[number];
  blurb: string; swatch: [string, string]; spec: ShotSpec; prose: string;
};

export const BUILTIN_LOOKS: Builtin[] = [
  { slug: "golden-editorial", name: "Golden Editorial", category: "Editorial",
    blurb: "Late sun from behind, warm skin, soft roll-off.",
    swatch: ["#F2B36A", "#7A3E1F"],
    spec: { shot: "mcu", lens: "85", light: "back", time: "golden", look: "35mm", mood: "intimate" },
    prose: "Late golden-hour sun from behind the subject, a warm rim on hair and shoulders, a soft flare held just off the lens. Skin warm and clean. Mid contrast with a soft roll-off in the highlights and fine 35mm grain. Shallow depth of field at 85mm, the background dissolving into warm bokeh." },
  { slug: "sunlit-interior", name: "Sunlit Interior", category: "Editorial",
    blurb: "One window, dust in the beam, pale walls.",
    swatch: ["#F3E6CF", "#9C7B55"],
    spec: { shot: "ms", lens: "50", light: "natural", time: "morning", look: "35mm", mood: "calm" },
    prose: "A single soft daylight source from a window to one side, dust visible in the beam, warm bounce off pale walls. Gentle contrast, shadows open. Nothing else lit; the room reads calm and lived-in." },
  { slug: "anamorphic-widescreen", name: "Anamorphic Widescreen", category: "Editorial",
    blurb: "Oval bokeh, blue streak flares, off-centre frames.",
    swatch: ["#2E3D6B", "#C9A24C"],
    spec: { lens: "anamorphic", light: "back", time: "dusk", look: "35mm", mood: "epic" },
    prose: "Anamorphic lensing: oval bokeh, horizontal blue streak flares off the brightest sources, a gentle stretch at the edges of the frame. Wide compositions with the subject off-centre and room around it. Dusk light, low and warm against a cooling sky." },
  { slug: "monochrome-editorial", name: "Monochrome Editorial", category: "Editorial",
    blurb: "Hard light, silver mid-tones, shape and shadow.",
    swatch: ["#FAFAFA", "#202020"],
    spec: { look: "bw", light: "hard", lens: "50", angle: "eye", mood: "intimate" },
    prose: "Black and white with silver mid-tones: hard directional light, deep clean blacks and bright whites, shape carried by shadow. Fine grain. No tint." },
  { slug: "teal-orange-commercial", name: "Teal & Orange", category: "Commercial",
    blurb: "Warm skin, cool world, glossy and punchy.",
    swatch: ["#1F7A86", "#F2903E"],
    spec: { look: "teal", light: "rim", lens: "35", mood: "epic", pace: "ramp" },
    prose: "Commercial grade: warm skin held against teal shadows and cool backgrounds, glossy high-key highlights, a strong rim light separating the subject from the world. Punchy contrast with clean blacks." },
  { slug: "fashion-flash", name: "Fashion Flash", category: "Commercial",
    blurb: "On-camera flash, hard drop shadow, saturated.",
    swatch: ["#F4F4F2", "#C4243C"],
    spec: { light: "hard", look: "clean", lens: "35", mood: "joyful", move: "static" },
    prose: "Direct on-camera flash: hard frontal light with a crisp drop shadow on the surface behind, saturated colour, high contrast, a gloss on skin. The paparazzi-editorial look, unsoftened." },
  { slug: "documentary-handheld", name: "Documentary Handheld", category: "Documentary",
    blurb: "Available light, breathing camera, honest grade.",
    swatch: ["#9AA3A8", "#3C4246"],
    spec: { move: "handheld", light: "natural", lens: "24", look: "clean", mood: "documentary", pace: "realtime" },
    prose: "Available light only. A neutral, unstyled grade with no diffusion and no glow; textures left honest; nothing lit for the camera." },
  { slug: "overcast-nordic", name: "Overcast Nordic", category: "Documentary",
    blurb: "Flat grey daylight, muted greens, small subject.",
    swatch: ["#B9C2C8", "#52606A"],
    spec: { light: "soft", time: "morning", look: "muted", lens: "24", shot: "ws", mood: "melancholy" },
    prose: "Flat overcast daylight from above, shadowless and even. A muted, slightly cool palette of grey-blues and moss greens. No warmth added. The subject kept small in a wide frame." },
  { slug: "studio-beauty", name: "Studio Beauty", category: "Beauty",
    blurb: "Beauty dish and fill, luminous skin, clean backdrop.",
    swatch: ["#F6E9E3", "#C79A8C"],
    spec: { shot: "cu", light: "soft", look: "clean", lens: "85", angle: "eye", mood: "calm", move: "static" },
    prose: "Beauty lighting: a large soft source just above the lens with a fill from below, skin luminous and even, catchlights in the eyes. A clean seamless backdrop. No colour cast." },
  { slug: "golden-skin", name: "Golden Skin", category: "Beauty",
    blurb: "Warm side light, glow without haze.",
    swatch: ["#F0C9A0", "#8B5A3C"],
    spec: { shot: "cu", light: "soft", time: "golden", lens: "85", look: "35mm", mood: "intimate", move: "push" },
    prose: "Warm soft light from the side, a gentle glow on skin without haze or diffusion filters, highlights kept from clipping. Shallow focus on the eyes. A slow push in." },
  { slug: "clean-product", name: "Clean Product", category: "Product",
    blurb: "Seamless backdrop, soft top light, true colour.",
    swatch: ["#FFFFFF", "#D8DADF"],
    spec: { shot: "insert", light: "soft", look: "clean", lens: "macro", angle: "eye", mood: "calm", move: "orbit" },
    prose: "Product on a seamless backdrop: soft top light with a gentle gradient falloff, controlled speculars along the edges, true colour, no dust. Crisp focus across the whole object. A slow, even move." },
  { slug: "macro-detail", name: "Macro Detail", category: "Product",
    blurb: "Thin focus, raking light, material as texture.",
    swatch: ["#E5D3C0", "#5B4636"],
    spec: { shot: "ecu", lens: "macro", light: "soft", move: "push", pace: "slowmo", mood: "intimate" },
    prose: "Macro study: a razor-thin plane of focus, materials rendered as surface and grain, light raking across to reveal relief. Slow motion holds the detail." },
  { slug: "tungsten-night", name: "Tungsten Night", category: "Night",
    blurb: "Practicals and sodium, deep blacks, halation.",
    swatch: ["#E8A34B", "#14110D"],
    spec: { light: "practical", time: "night", look: "35mm", lens: "35", mood: "melancholy" },
    prose: "Night lit only by tungsten practicals and sodium street light: warm pools against deep clean blacks, halation around the brightest sources, muted greens and ambers, no blue fill. A little grain in the shadows." },
  { slug: "blue-hour-city", name: "Blue Hour City", category: "Night",
    blurb: "Cool sky, warm neon, wet reflections.",
    swatch: ["#2A4C8A", "#E0508A"],
    spec: { time: "blue", light: "neon", lens: "35", look: "clean", mood: "calm" },
    prose: "Blue hour: a cool ambient sky against warm neon and shop practicals, wet surfaces carrying long reflections. Cyan and magenta accents on a cold base. Contrast kept gentle so the sky holds detail." },
  { slug: "neo-noir", name: "Neo-Noir", category: "Night",
    blurb: "One hard key, venetian shadows, silver black-and-white.",
    swatch: ["#1B1C21", "#C8CCD4"],
    spec: { light: "chiaro", time: "night", look: "bw", angle: "low", lens: "35", mood: "tense" },
    prose: "A single hard key raking across the subject, venetian shadow bars, deep pure blacks with one bright edge. Black and white with a cool silver tone. Haze catches the beam." },
  { slug: "kodak-portra", name: "Portra", category: "Film stock",
    blurb: "Pastel skin, lifted shadows, gentle warmth.",
    swatch: ["#EFCBB8", "#7C8F7A"],
    spec: { look: "35mm", light: "soft", time: "afternoon", lens: "50", mood: "calm" },
    prose: "Colour-negative film: pastel skin, low contrast with lifted shadows, gentle warmth in the mid-tones, greens slightly muted. Soft fine grain. Highlights roll off rather than clip." },
  { slug: "bleach-bypass", name: "Bleach Bypass", category: "Film stock",
    blurb: "Desaturated, silver highlights, crushed blacks.",
    swatch: ["#C9C9C4", "#2B2C2C"],
    spec: { look: "bleach", light: "hard", mood: "tense" },
    prose: "Skip-bleach grade: desaturated colour with silvery high-contrast highlights and crushed blacks, skin cool and slightly metallic, grain visible in the mid-tones." },
  { slug: "super-8-memory", name: "Super 8 Memory", category: "Analogue",
    blurb: "Heavy warm grain, faded highlights, gate weave.",
    swatch: ["#E7B07A", "#8A5A3A"],
    spec: { look: "16mm", light: "natural", time: "afternoon", pace: "realtime", mood: "joyful" },
    prose: "Super 8 home-movie texture: heavy warm grain, faded highlights, slight gate weave and soft focus, colours washed toward orange and cream, exposure drifting a little from frame to frame." },
  { slug: "vhs-memory", name: "VHS Memory", category: "Analogue",
    blurb: "Chroma bleed, tracking noise, lamp light.",
    swatch: ["#7A5C9E", "#1E1A26"],
    spec: { look: "vhs", light: "mixed", mood: "melancholy" },
    prose: "Consumer VHS: soft chroma bleed, tracking noise at the frame edge, low resolution with visible scan lines, colours smeared and slightly magenta. Hard interior light from a lamp." },
  { slug: "sports-kinetic", name: "Sports Kinetic", category: "Motion",
    blurb: "Locked tracking, crisp frames, speed ramps.",
    swatch: ["#F0F0F0", "#1A1A1A"],
    spec: { move: "chase", lens: "24", light: "hard", pace: "ramp", mood: "epic", look: "clean" },
    prose: "Kinetic coverage: the camera locked on the athlete through fast tracking, every frame crisp as if at a high shutter, speed ramps on the moments of impact. Hard directional light and deep contrast." },
  { slug: "drone-establishing", name: "Drone Establishing", category: "Motion",
    blurb: "High and wide, long shadows, a steady drift.",
    swatch: ["#F5C77A", "#3B5A8A"],
    spec: { technique: "aerial", shot: "evs", time: "golden", light: "natural", mood: "epic", pace: "realtime" },
    prose: "Aerial establishing: high and wide, the landscape reading as pattern, long shadows across the ground in low sun. A slow steady drift with no sudden moves." },
];

let seeded = false;
/**
 * The shipped Looks are rows too, so the composer, the API and the MCP tool
 * treat them like any other — but they are re-asserted on every deploy, so
 * a better-written block reaches every workspace. Covers a team has chosen
 * are kept.
 */
export async function ensureBuiltinLooks(): Promise<void> {
  if (seeded) return;
  await ready();
  const ts = now();
  for (const b of BUILTIN_LOOKS) {
    await db().execute({
      sql: `INSERT INTO shot_presets
              (id, project_id, name, spec, created_by, created_at,
               slug, category, blurb, prose, refs, swatch, builtin, updated_at)
            VALUES (?, NULL, ?, ?, '', ?, ?, ?, ?, ?, '[]', ?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, spec=excluded.spec, category=excluded.category,
              blurb=excluded.blurb, prose=excluded.prose, swatch=excluded.swatch,
              builtin=1, updated_at=excluded.updated_at`,
      args: [`look_b_${b.slug}`, b.name, JSON.stringify(b.spec), ts,
             b.slug, b.category, b.blurb, b.prose, JSON.stringify(b.swatch), ts],
    });
  }
  seeded = true;
}

export function newLookId(): string { return newId("look"); }

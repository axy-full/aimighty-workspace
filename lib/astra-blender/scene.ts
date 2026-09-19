import { z } from "zod";

export const ASTRA_BLENDER_MODEL = "openai/gpt-6-astra" as const;
export const ASTRA_SCENE_LIMITS = {
  objects: 64,
  lights: 12,
  keyframesPerObject: 32,
  keyframes: 512,
  textLength: 160,
  coordinate: 1000,
  scale: 100,
  frame: 7200,
  timelineFrames: 1800,
  fps: 60,
  renderDimension: 2048,
  renderPixels: 4_194_304,
  samples: 128,
} as const;

const finite = (min: number, max: number) => z.number().finite().min(min).max(max);
const vector = (min: number, max: number) => z.tuple([finite(min, max), finite(min, max), finite(min, max)]);
const position = vector(-ASTRA_SCENE_LIMITS.coordinate, ASTRA_SCENE_LIMITS.coordinate);
const rotation = vector(-3600, 3600);
const scale = vector(0.001, ASTRA_SCENE_LIMITS.scale);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color.");
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/, "Use a short alphanumeric ID.")
  .refine(value => !["__proto__", "prototype", "constructor"].includes(value), "Reserved ID.");
const name = z.string().trim().min(1).max(100);
const assetId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/)
  .refine(value => !["__proto__", "prototype", "constructor"].includes(value), "Reserved asset ID.");
const frame = z.number().int().min(1).max(ASTRA_SCENE_LIMITS.frame);

export const astraMaterialSchema = z.object({
  color,
  metalness: finite(0, 1),
  roughness: finite(0, 1),
}).strict();

export const astraKeyframeSchema = z.object({ frame, position, rotation, scale }).strict();
export const astraObjectSchema = z.object({
  id, name,
  type: z.enum(["box", "sphere", "cylinder", "cone", "plane", "torus", "text", "model", "image"]),
  position, rotation, scale,
  visible: z.boolean(),
  locked: z.boolean(),
  material: astraMaterialSchema,
  assetId: assetId.optional(),
  text: z.string().min(1).max(ASTRA_SCENE_LIMITS.textLength).optional(),
  keyframes: z.array(astraKeyframeSchema).max(ASTRA_SCENE_LIMITS.keyframesPerObject),
}).strict().superRefine((object, context) => {
  const imported = object.type === "model" || object.type === "image";
  if (imported !== (object.assetId !== undefined)) context.addIssue({ code: "custom", path: ["assetId"], message: "Only model and image objects require an asset ID." });
  if ((object.type === "text") !== (object.text !== undefined)) context.addIssue({ code: "custom", path: ["text"], message: "Only text objects require text." });
  object.keyframes.forEach((key, index) => {
    if (index > 0 && key.frame <= object.keyframes[index - 1].frame)
      context.addIssue({ code: "custom", path: ["keyframes", index, "frame"], message: "Keyframes must have distinct, increasing frames." });
  });
});

export const astraLightSchema = z.object({
  id, name,
  type: z.enum(["area", "point", "sun"]),
  position, rotation, color,
  power: finite(0, 10000),
  size: finite(0.01, 100),
}).strict().superRefine((light, context) => {
  if (light.type === "sun" && light.power > 20) context.addIssue({ code: "custom", path: ["power"], message: "Sun strength cannot exceed 20." });
});

/**
 * Metres, Z up, XYZ Euler rotations in degrees. Primitive sizes before scale:
 * box 1³; sphere radius .5; cylinder/cone radius .5 and depth 1; XY plane 1²;
 * torus major radius .375, minor radius .125; text Blender's default 1m font.
 * Image planes are 1×1 before scale; source aspect is an explicit scale choice.
 * Imported GLB retains its original geometry/materials under this transform.
 * Light power is Blender watts (point/area) or irradiance (sun); size is area
 * width or point shadow radius. Sun uses a fixed .526-degree angular diameter.
 */
export const astraSceneSchema = z.object({
  schemaVersion: z.literal(1),
  name,
  objects: z.array(astraObjectSchema).max(ASTRA_SCENE_LIMITS.objects),
  lights: z.array(astraLightSchema).max(ASTRA_SCENE_LIMITS.lights),
  camera: z.object({ position, target: position, focalLength: finite(12, 200) }).strict(),
  world: z.object({ color, strength: finite(0, 5) }).strict(),
  timeline: z.object({ start: frame, end: frame, fps: z.number().int().min(1).max(ASTRA_SCENE_LIMITS.fps) }).strict(),
  render: z.object({
    width: z.number().int().min(64).max(ASTRA_SCENE_LIMITS.renderDimension),
    height: z.number().int().min(64).max(ASTRA_SCENE_LIMITS.renderDimension),
    samples: z.number().int().min(1).max(ASTRA_SCENE_LIMITS.samples),
    transparent: z.boolean(),
  }).strict(),
}).strict().superRefine((scene, context) => {
  const seen = new Set<string>();
  for (const field of ["objects", "lights"] as const) scene[field].forEach((item, index) => {
    if (seen.has(item.id)) context.addIssue({ code: "custom", path: [field, index, "id"], message: "Scene IDs must be unique across objects and lights." });
    seen.add(item.id);
  });
  if (scene.timeline.end < scene.timeline.start || scene.timeline.end - scene.timeline.start + 1 > ASTRA_SCENE_LIMITS.timelineFrames)
    context.addIssue({ code: "custom", path: ["timeline", "end"], message: `Use an increasing timeline of at most ${ASTRA_SCENE_LIMITS.timelineFrames} frames.` });
  let keys = 0;
  const bindings = new Map<string, string>();
  scene.objects.forEach((object, index) => {
    if (object.assetId) {
      const previous = bindings.get(object.assetId);
      if (previous && previous !== object.type) context.addIssue({ code: "custom", path: ["objects", index, "assetId"], message: "An asset cannot be both an image and a model." });
      bindings.set(object.assetId, object.type);
    }
    keys += object.keyframes.length;
    object.keyframes.forEach((key, keyIndex) => {
      if (key.frame < scene.timeline.start || key.frame > scene.timeline.end)
        context.addIssue({ code: "custom", path: ["objects", index, "keyframes", keyIndex, "frame"], message: "Keyframe must be inside the scene timeline." });
    });
  });
  if (keys > ASTRA_SCENE_LIMITS.keyframes) context.addIssue({ code: "custom", path: ["objects"], message: "The scene has too many keyframes." });
  if (scene.camera.position.every((value, index) => Math.abs(value - scene.camera.target[index]) < 0.000001))
    context.addIssue({ code: "custom", path: ["camera", "target"], message: "The camera target must differ from its position." });
  if (scene.render.width * scene.render.height > ASTRA_SCENE_LIMITS.renderPixels)
    context.addIssue({ code: "custom", path: ["render"], message: "The render is too large." });
});

export type AstraScene = z.infer<typeof astraSceneSchema>;
export type AstraObject = z.infer<typeof astraObjectSchema>;
export type AstraLight = z.infer<typeof astraLightSchema>;
export type AstraMaterial = z.infer<typeof astraMaterialSchema>;
export type AstraKeyframe = z.infer<typeof astraKeyframeSchema>;
export type AstraVector3 = [number, number, number];
export type AstraTemplate = "empty" | "product" | "interior" | "abstract";
export type AstraTransform = Pick<AstraObject, "position" | "rotation" | "scale">;

/** Parse data, never script, URLs or arbitrary extra renderer options. */
export function parseAstraScene(value: unknown): AstraScene {
  // Zod deliberately ignores __proto__ while constructing objects. Reject it
  // explicitly at ingestion rather than silently accepting poisoned wire data.
  let visited = 0;
  const ancestors = new Set<object>();
  const inspect = (input: unknown, depth: number) => {
    if (++visited > 30000 || depth > 12) throw new Error("Scene data exceeds its structural limit.");
    if (input === null || typeof input !== "object") return;
    if (ancestors.has(input)) throw new Error("Scene data cannot contain cycles.");
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype && !(Array.isArray(input) && prototype === Array.prototype))
      throw new Error("Scene data must contain plain JSON objects.");
    ancestors.add(input);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
      if (["__proto__", "prototype", "constructor"].includes(key) || descriptor.get || descriptor.set)
        throw new Error("Scene data contains a forbidden property.");
      inspect(descriptor.value, depth + 1);
    }
    ancestors.delete(input);
  };
  inspect(value, 0);
  return astraSceneSchema.parse(value);
}

/** Linear Euler interpolation, held at the first/last key outside keyed range. */
export function sampleAstraObjectTransform(object: AstraObject, atFrame: number): AstraTransform {
  if (!Number.isFinite(atFrame)) throw new Error("Use a finite animation frame.");
  const keys = object.keyframes;
  const copy = (value: AstraTransform): AstraTransform => ({ position: [...value.position], rotation: [...value.rotation], scale: [...value.scale] });
  if (!keys.length) return copy(object);
  if (atFrame <= keys[0].frame) return copy(keys[0]);
  const last = keys[keys.length - 1];
  if (atFrame >= last.frame) return copy(last);
  const right = keys.findIndex(key => key.frame >= atFrame);
  const before = keys[right - 1], after = keys[right];
  const amount = (atFrame - before.frame) / (after.frame - before.frame);
  const interpolate = (a: AstraVector3, b: AstraVector3): AstraVector3 => a.map((value, index) => value + (b[index] - value) * amount) as AstraVector3;
  return { position: interpolate(before.position, after.position), rotation: interpolate(before.rotation, after.rotation), scale: interpolate(before.scale, after.scale) };
}

function object(id: string, type: AstraObject["type"], name: string, overrides: Partial<AstraObject> = {}): AstraObject {
  return { id, type, name, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true, locked: false, material: { color: "#c6bdb0", metalness: 0, roughness: 0.4 }, keyframes: [], ...overrides };
}

/** Templates are real editable geometry, returned as fresh independent data. */
export function createAstraScene(template: AstraTemplate = "empty"): AstraScene {
  const scene: AstraScene = {
    schemaVersion: 1,
    name: "Untitled scene",
    objects: [],
    lights: [
      { id: "key-light", name: "Key light", type: "area", position: [3, -4, 5], rotation: [28, 0, 35], color: "#fff0dc", power: 650, size: 4 },
      { id: "fill-light", name: "Fill light", type: "area", position: [-3, -1, 3], rotation: [20, -35, -30], color: "#d4e6ff", power: 350, size: 3 },
    ],
    camera: { position: [4, -6, 3], target: [0, 0, 0.75], focalLength: 50 },
    world: { color: "#30343b", strength: 0.3 },
    timeline: { start: 1, end: 120, fps: 24 },
    render: { width: 1280, height: 960, samples: 32, transparent: false },
  };
  if (template === "product") {
    scene.name = "Product study";
    scene.objects = [
      object("backdrop", "plane", "Studio floor", { scale: [20, 20, 1], material: { color: "#e3ddd2", metalness: 0, roughness: 0.8 } }),
      object("plinth", "cylinder", "Display plinth", { position: [0, 0, 0.2], scale: [2, 2, 0.4], material: { color: "#ddd3bd", metalness: 0, roughness: 0.55 } }),
      object("product", "cylinder", "Product body", { position: [0, 0, 1], scale: [0.7, 0.7, 1.2], material: { color: "#a46b3d", metalness: 0.65, roughness: 0.25 } }),
      object("cap", "cylinder", "Product cap", { position: [0, 0, 1.68], scale: [0.72, 0.72, 0.16], material: { color: "#343536", metalness: 0.75, roughness: 0.2 } }),
    ];
    scene.camera = { position: [3.6, -5, 2.8], target: [0, 0, 0.95], focalLength: 65 };
  } else if (template === "interior") {
    scene.name = "Interior study";
    scene.objects = [
      object("floor", "plane", "Floor", { scale: [8, 8, 1], material: { color: "#a88764", metalness: 0, roughness: 0.65 } }),
      object("back-wall", "box", "Back wall", { position: [0, 3, 1.5], scale: [8, 0.15, 3], material: { color: "#e5ded1", metalness: 0, roughness: 0.85 } }),
      object("side-wall", "box", "Side wall", { position: [-4, 0, 1.5], scale: [0.15, 6, 3], material: { color: "#e5ded1", metalness: 0, roughness: 0.85 } }),
      object("seat", "box", "Sofa seat", { position: [-0.4, 1.1, 0.55], scale: [2.8, 1.1, 0.5], material: { color: "#627567", metalness: 0, roughness: 0.95 } }),
      object("seat-back", "box", "Sofa back", { position: [-0.4, 1.55, 1], scale: [2.8, 0.25, 0.75], material: { color: "#627567", metalness: 0, roughness: 0.95 } }),
      object("table", "cylinder", "Low table", { position: [0.4, -0.4, 0.3], scale: [1.4, 1.4, 0.6], material: { color: "#dcc2a3", metalness: 0, roughness: 0.4 } }),
      object("vase", "sphere", "Sculptural vase", { position: [0.4, -0.4, 0.84], scale: [0.3, 0.3, 0.48], material: { color: "#984b34", metalness: 0, roughness: 0.35 } }),
    ];
    scene.camera = { position: [6, -8, 4], target: [-0.4, 0.7, 0.9], focalLength: 42 };
    scene.world.strength = 0.5;
  } else if (template === "abstract") {
    scene.name = "Orbital study";
    scene.objects = [
      object("floor", "plane", "Dark ground", { scale: [20, 20, 1], material: { color: "#151923", metalness: 0.15, roughness: 0.3 } }),
      object("orb", "sphere", "Chrome orb", { position: [0, 0, 1.15], scale: [1.4, 1.4, 1.4], material: { color: "#cbd5e4", metalness: 0.95, roughness: 0.16 } }),
      object("ring", "torus", "Orbit", { position: [0, 0, 1.15], rotation: [35, 20, 0], scale: [3, 3, 3], material: { color: "#d89046", metalness: 0.65, roughness: 0.25 }, keyframes: [
        { frame: 1, position: [0, 0, 1.15], rotation: [35, 20, 0], scale: [3, 3, 3] },
        { frame: 120, position: [0, 0, 1.15], rotation: [35, 20, 360], scale: [3, 3, 3] },
      ] }),
    ];
    scene.camera = { position: [4, -6, 3.5], target: [0, 0, 1.2], focalLength: 55 };
  } else if (template !== "empty") {
    throw new Error("Choose an available Astra template.");
  }
  return parseAstraScene(scene);
}
